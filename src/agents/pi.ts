/**
 * agents/pi.ts — Pi agent adapter
 *
 * Wraps pi's SDK (createAgentSession) as an AgentAdapter.
 * One persistent session per thread, stored at:
 *   ~/.pi/agent/gateway-sessions/<thread_id>/<session>.jsonl
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import type { AgentAdapter, AgentAdapterFactory, AgentResponse, AgentStreamEvent } from "../types";
import { threadIdToDir } from "../util";

interface SessionEntry {
  session: AgentSession;
  lastUsed: number;
}

const DEFAULT_SESSIONS_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "gateway-sessions"
);
const DEFAULT_MAX_IDLE_MS = 30 * 60 * 1000;

export const createPiAgentAdapter: AgentAdapterFactory = (config) => {
  const cwd = (config.cwd as string) ?? process.cwd();
  const sessionsDir =
    (config.sessionDir as string) ?? DEFAULT_SESSIONS_DIR;
  const maxIdleMs =
    (config.maxIdleMs as number) ?? DEFAULT_MAX_IDLE_MS;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const sessions = new Map<string, SessionEntry>();
  const creating = new Map<string, Promise<SessionEntry>>();
  let reapInterval: ReturnType<typeof setInterval> | undefined;

  async function createSession(threadId: string): Promise<SessionEntry> {
    const threadDir = join(sessionsDir, threadIdToDir(threadId));
    await mkdir(threadDir, { recursive: true });

    let sessionManager: InstanceType<typeof SessionManager>;

    try {
      sessionManager = SessionManager.continueRecent(cwd, threadDir);
      console.log(
        `[pi-agent] resuming session for ${threadId}: ${sessionManager.getSessionFile()}`
      );
    } catch {
      sessionManager = SessionManager.create(cwd, threadDir);
      console.log(
        `[pi-agent] new session for ${threadId}: ${sessionManager.getSessionFile()}`
      );
    }

    const result = await createAgentSession({
      cwd,
      sessionManager,
      authStorage,
      modelRegistry,
    });

    if (result.extensionsResult.extensions.length > 0) {
      console.log(
        `[pi-agent] extensions loaded: ${result.extensionsResult.extensions.map((e: any) => e.name || e.path).join(", ")}`
      );
    } else {
      console.log(`[pi-agent] no extensions loaded`);
    }
    if (result.extensionsResult.errors.length > 0) {
      for (const err of result.extensionsResult.errors) {
        console.warn(`[pi-agent] extension error: ${err.path}: ${err.error}`);
      }
    }

    if (result.modelFallbackMessage) {
      console.log(`[pi-agent] model fallback: ${result.modelFallbackMessage}`);
    }

    const entry: SessionEntry = { session: result.session, lastUsed: Date.now() };
    sessions.set(threadId, entry);
    return entry;
  }

  async function getOrCreate(threadId: string): Promise<SessionEntry> {
    const existing = sessions.get(threadId);
    if (existing) return existing;

    let pending = creating.get(threadId);
    if (pending) return pending;

    pending = createSession(threadId).finally(() => {
      creating.delete(threadId);
    });
    creating.set(threadId, pending);
    return pending;
  }

  function reap() {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsed > maxIdleMs) {
        entry.session.dispose();
        sessions.delete(id);
        console.log(`[pi-agent] reaped idle handle for ${id}`);
      }
    }
  }

  reapInterval = setInterval(reap, 60_000);
  reapInterval.unref();

  // Per-thread serialization for both prompt() and promptStream()
  const threadQueues = new Map<string, Promise<any>>();

  function enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = threadQueues.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    threadQueues.set(threadId, current);
    return current.finally(() => {
      if (threadQueues.get(threadId) === current) {
        threadQueues.delete(threadId);
      }
    });
  }

  const adapter: AgentAdapter = {
    name: "pi",

    async prompt(threadId: string, text: string): Promise<AgentResponse> {
      return enqueue(threadId, () => doPrompt(threadId, text));
    },

    promptStream(threadId: string, text: string): AsyncIterable<AgentStreamEvent> {
      // Return an async iterable that is single-use by design.
      // State is scoped inside the iterator factory to prevent sharing.
      let consumed = false;

      return {
        [Symbol.asyncIterator]() {
          if (consumed) throw new Error("promptStream() iterable can only be consumed once");
          consumed = true;

          let eventQueue: AgentStreamEvent[] = [];
          let resolve: (() => void) | null = null;
          let done = false;
          let error: Error | null = null;

          // Start the prompt in the thread queue
          const promptDone = enqueue(threadId, async () => {
            const entry = await getOrCreate(threadId);
            entry.lastUsed = Date.now();

            const unsub = entry.session.subscribe((event: AgentSessionEvent) => {
              let streamEvent: AgentStreamEvent | null = null;

              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                streamEvent = { type: "text_delta", text: event.assistantMessageEvent.delta };
              } else if (event.type === "message_end" && (event.message as any).role === "custom" && (event.message as any).display) {
                // Extension messages (e.g. code review results)
                const content = (event.message as any).content;
                if (typeof content === "string" && content.trim()) {
                  streamEvent = { type: "text_delta", text: "\n\n" + content };
                }
              } else if (event.type === "tool_execution_start") {
                streamEvent = { type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId };
              } else if (event.type === "tool_execution_end") {
                streamEvent = { type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
              } else if (event.type === "turn_end") {
                streamEvent = { type: "turn_end" };
              }

              if (streamEvent) {
                eventQueue.push(streamEvent);
                resolve?.();
              }
            });

            try {
              await entry.session.prompt(text);
            } finally {
              unsub();
              eventQueue.push({ type: "agent_end" });
              done = true;
              resolve?.();
            }
          });

          promptDone.catch((err) => {
            error = err instanceof Error ? err : new Error(String(err));
            done = true;
            resolve?.();
          });

          return {
            async next(): Promise<IteratorResult<AgentStreamEvent>> {
              while (true) {
                if (eventQueue.length > 0) {
                  return { value: eventQueue.shift()!, done: false };
                }
                if (error) throw error;
                if (done) return { value: undefined as any, done: true };
                // Wait for next event
                await new Promise<void>((r) => { resolve = r; });
                resolve = null;
              }
            },
          };
        },
      };
    },

    async dispose(): Promise<void> {
      if (reapInterval) clearInterval(reapInterval);
      for (const [, entry] of sessions) {
        entry.session.dispose();
      }
      sessions.clear();
      creating.clear();
      threadQueues.clear();
    },
  };

  async function doPrompt(threadId: string, text: string): Promise<AgentResponse> {
    const entry = await getOrCreate(threadId);
    entry.lastUsed = Date.now();

    let fullText = "";
    const unsub = entry.session.subscribe((event: AgentSessionEvent) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        fullText += event.assistantMessageEvent.delta;
      }
    });

    try {
      await entry.session.prompt(text);
    } finally {
      unsub();
    }

    return { text: fullText };
  }

  return adapter;
};

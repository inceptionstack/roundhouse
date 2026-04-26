/**
 * agents/pi.ts — Pi agent adapter
 *
 * Wraps pi's SDK (createAgentSession) as an AgentAdapter.
 * One persistent session per thread, stored at:
 *   ~/.pi/agent/gateway-sessions/<thread_id>/<session>.jsonl
 */

import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __piAdapterDir = dirname(fileURLToPath(import.meta.url));

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import type { AgentAdapter, AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent } from "../types";
import { DEBUG_STREAM, threadIdToDir } from "../util";

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

  async function drainSessionEvents(session: AgentSession): Promise<void> {
    // AgentSession._handleAgentEvent queues event processing on a private
    // promise chain (_agentEventQueue). session.prompt() / agent.continue()
    // resolve when the agent loop finishes, but NOT when the queue drains.
    // We must await the queue so that:
    //   1. agent_end extension handlers (e.g. pi-lgtm review) complete
    //   2. followUp messages they queue are visible via hasQueuedMessages()
    //   3. message_end events for custom messages reach our subscribe() handler
    //      BEFORE we unsubscribe in the finally block.
    //
    // WARNING: _agentEventQueue is a private field of AgentSession (not part
    // of the public pi-coding-agent API). Tested against
    // @mariozechner/pi-coding-agent version bundled via `latest` in
    // package.json at the time of this commit. If upstream renames or changes
    // this field, extension custom messages (e.g. pi-lgtm review bubbles)
    // will stop reaching Telegram. The `if (queue)` check fails silently
    // on purpose because a missing field is not fatal — it just reverts to
    // the pre-fix race condition. A public `session.flushEvents()` or
    // `session.waitForIdle()` upstream would obsolete this.
    const queue = (session as unknown as { _agentEventQueue?: Promise<void> })._agentEventQueue;
    if (queue) {
      await queue;
    }
  }

  function customContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: "text"; text: string } =>
          !!part && typeof part === "object" && (part as any).type === "text"
        )
        .map((part) => part.text)
        .join("");
    }
    return "";
  }

  /**
   * Extract displayable text from a session event if it is an extension custom
   * message (e.g. pi-lgtm review) with display=true. Returns null otherwise.
   * Shared helper so promptStream() and doPrompt() use identical filter logic.
   */
  function extractCustomMessage(event: AgentSessionEvent): { customType: string; content: string } | null {
    if (event.type !== "message_end") return null;
    const message = (event as any).message;
    if (!message || message.role !== "custom" || !message.display) return null;
    const content = customContentToText(message.content);
    if (!content.trim()) return null;
    const customType = message.customType ?? "";
    return { customType, content };
  }

  async function runPromptAndFollowUps(entry: SessionEntry, text: string, onDraining?: () => void, onDrainComplete?: () => void): Promise<void> {
    await entry.session.prompt(text);
    await drainSessionEvents(entry.session);

    // Check for pending follow-up work AFTER drainSessionEvents — that's
    // where agent_end extension handlers run and queue follow-up messages
    // (e.g. pi-lgtm calls sendMessage with deliverAs: "followUp").
    // The actual long wait is in the while loop's waitForIdle() below.
    let notifiedDraining = false;
    if (onDraining && (entry.session.isStreaming || entry.session.agent.hasQueuedMessages())) {
      onDraining();
      notifiedDraining = true;
    }

    // Loop until the session is fully idle. Two separate conditions can keep
    // work in flight after the initial prompt resolves:
    //
    //  (a) `hasQueuedMessages()` — an extension called `pi.sendMessage(...,
    //      { triggerTurn: true, deliverAs: "followUp" })` *while isStreaming
    //      was true* — pi queued onto `agent.followUp()`, so we manually
    //      drain it with `continue()`.
    //
    //  (b) `isStreaming === true` — an extension called the same sendMessage
    //      *after isStreaming became false*. In that path pi's
    //      `sendCustomMessage` skips the queue entirely and calls
    //      `agent.prompt(appMessage)` directly as fire-and-forget, kicking
    //      off a brand-new agent run. `hasQueuedMessages()` returns false
    //      for this run, but `isStreaming` is true — we have to
    //      `waitForIdle()` so subscribers see the new run's events (e.g. the
    //      agent's reply to a pi-lgtm code review) before we unsubscribe.
    //
    // Without (b), pi CLI works (its subscriber stays attached across runs)
    // but roundhouse delivers the review bubble then goes silent.
    while (true) {
      if (entry.session.isStreaming) {
        await entry.session.agent.waitForIdle();
        await drainSessionEvents(entry.session);
        continue;
      }
      if (entry.session.agent.hasQueuedMessages()) {
        await entry.session.agent.continue();
        await drainSessionEvents(entry.session);
        continue;
      }
      break;
    }

    if (notifiedDraining && onDrainComplete) {
      onDrainComplete();
    }
  }

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

  /**
   * Format an AgentMessage into the text string sent to the Pi session.
   * Attachments are rendered as a fenced JSON manifest appended to the user text.
   */
  function formatMessage(message: AgentMessage): string {
    let text = message.text;
    if (message.attachments?.length) {
      const manifest = JSON.stringify(
        message.attachments.map((a) => ({
          id: a.id,
          type: a.mediaType,
          name: a.name,
          localPath: a.localPath,
          mime: a.mime,
          sizeBytes: a.sizeBytes,
          untrusted: true,
        })),
        null,
        2,
      );
      const block = [
        "Chat attachments saved locally. Inspect these files with tools before making claims about their contents.",
        "```json",
        manifest,
        "```",
      ].join("\n");
      text = text ? `${text}\n\n${block}` : block;
    }
    return text;
  }

  const adapter: AgentAdapter = {
    name: "pi",

    async prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
      return enqueue(threadId, () => doPrompt(threadId, formatMessage(message)));
    },

    promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
      const text = formatMessage(message);
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
              if (DEBUG_STREAM) {
                const extra =
                  event.type === "message_end" || event.type === "message_start"
                    ? ` role=${(event as any).message?.role}`
                    : event.type === "message_update"
                      ? ` subType=${(event as any).assistantMessageEvent?.type}`
                      : "";
                console.log(`[pi-agent/sub] event=${event.type}${extra}`);
              }
              let streamEvent: AgentStreamEvent | null = null;

              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                streamEvent = { type: "text_delta", text: event.assistantMessageEvent.delta };
              } else {
                const custom = extractCustomMessage(event);
                if (custom) {
                  streamEvent = { type: "custom_message", customType: custom.customType, content: custom.content };
                } else if (event.type === "tool_execution_start") {
                  streamEvent = { type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId };
                } else if (event.type === "tool_execution_end") {
                  streamEvent = { type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
                } else if (event.type === "turn_end") {
                  streamEvent = { type: "turn_end" };
                }
              }

              if (streamEvent) {
                eventQueue.push(streamEvent);
                resolve?.();
              }
            });

            try {
              await runPromptAndFollowUps(entry, text, () => {
                eventQueue.push({ type: "draining" });
                resolve?.();
              }, () => {
                eventQueue.push({ type: "drain_complete" });
                resolve?.();
              });
              // Final drain — guarantees all subscriber events have been delivered
              // before we unsubscribe below.
              await drainSessionEvents(entry.session);
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

    async restart(threadId: string): Promise<void> {
      await enqueue(threadId, async () => {
        const existing = sessions.get(threadId);
        if (existing) {
          existing.session.dispose();
          sessions.delete(threadId);
          console.log(`[pi-agent] disposed session for ${threadId}`);
        }
        // Next prompt() or promptStream() call will create a fresh session
      });
    },

    async compact(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
      return enqueue(threadId, async () => {
        const entry = sessions.get(threadId);
        if (!entry) return null;

        const result = await entry.session.compact();
        const usage = entry.session.getContextUsage();
        return {
          tokensBefore: result.tokensBefore,
          tokensAfter: usage?.tokens ?? null,
        };
      });
    },

    async abort(threadId: string): Promise<void> {
      const entry = sessions.get(threadId);
      if (entry) {
        await entry.session.abort();
        entry.session.abortCompaction();
        console.log(`[pi-agent] aborted session for ${threadId}`);
      }
    },

    getInfo(threadId?: string): Record<string, unknown> {
      // Get model from the requested thread's session, or most recently used
      let modelInfo: string | undefined;
      let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
      const threadEntry = threadId ? sessions.get(threadId) : undefined;

      if (threadEntry) {
        const model = threadEntry.session.model;
        if (model) modelInfo = `${model.provider}/${model.id}`;
        contextUsage = threadEntry.session.getContextUsage() ?? undefined;
      }

      if (!modelInfo) {
        let latestUsed = 0;
        for (const [, entry] of sessions) {
          if (entry.lastUsed > latestUsed) {
            latestUsed = entry.lastUsed;
            const model = entry.session.model;
            if (model) modelInfo = `${model.provider}/${model.id}`;
            if (!contextUsage) contextUsage = entry.session.getContextUsage() ?? undefined;
          }
        }
      }

      // Fall back to configured default from settings.json
      if (!modelInfo) {
        try {
          const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          if (settings.defaultProvider && settings.defaultModel) {
            modelInfo = `${settings.defaultProvider}/${settings.defaultModel}`;
          }
        } catch (err) {
          console.warn(`[pi-agent] could not read settings.json for model info:`, (err as Error).message);
        }
      }

      // Read agent version
      let version = "unknown";
      try {
        const piPkgPath = join(__piAdapterDir, "..", "..", "node_modules", "@mariozechner", "pi-coding-agent", "package.json");
        version = JSON.parse(readFileSync(piPkgPath, "utf8")).version;
      } catch {}

      return {
        version,
        model: modelInfo ?? "unknown",
        activeSessions: sessions.size,
        cwd,
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? null,
        contextPercent: contextUsage?.percent ?? null,
      };
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
      } else {
        const custom = extractCustomMessage(event);
        if (custom) {
          fullText += "\n\n" + custom.content;
        }
      }
    });

    try {
      await runPromptAndFollowUps(entry, text);
      await drainSessionEvents(entry.session);
    } finally {
      unsub();
    }

    return { text: fullText };
  }

  return adapter;
};

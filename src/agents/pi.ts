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

import type { AgentAdapter, AgentAdapterFactory, AgentResponse } from "../types";
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
  // Track in-flight session creation to prevent races
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

    if (result.modelFallbackMessage) {
      console.log(`[pi-agent] model fallback: ${result.modelFallbackMessage}`);
    }

    const entry: SessionEntry = { session: result.session, lastUsed: Date.now() };
    sessions.set(threadId, entry);
    return entry;
  }

  async function getOrCreate(threadId: string): Promise<SessionEntry> {
    // Fast path: already created
    const existing = sessions.get(threadId);
    if (existing) return existing;

    // Prevent concurrent creation for the same threadId
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

  // Start reaper (unref so it doesn't prevent Node from exiting)
  reapInterval = setInterval(reap, 60_000);
  reapInterval.unref();

  const adapter: AgentAdapter = {
    name: "pi",

    async prompt(threadId: string, text: string): Promise<AgentResponse> {
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
    },

    async dispose(): Promise<void> {
      if (reapInterval) clearInterval(reapInterval);
      for (const [, entry] of sessions) {
        entry.session.dispose();
      }
      sessions.clear();
      creating.clear();
    },
  };

  return adapter;
};

/**
 * kiro.ts — Kiro CLI AgentAdapter for Roundhouse
 *
 * Drives kiro-cli over ACP (Agent Control Protocol) via JSON-RPC stdio.
 * Implements the AgentAdapter interface with streaming support.
 *
 * Architecture:
 * - One kiro-cli process hosts all sessions (spawned lazily on first prompt)
 * - Sessions are per-thread, serialized via a queue to prevent concurrent prompts
 * - ACP events are mapped to AgentStreamEvent for the gateway
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentAdapter, AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent } from "../types.js";
import { AcpClient } from "./kiro/acp/client.js";
import { spawnKiroCli, shutdownProcess, getKiroCliVersion, type AcpProcess } from "./kiro/acp/process.js";
import type { AcpEvent, InitializeResult, SessionNewResult } from "./kiro/acp/types.js";
import { SessionStore, type SessionEntry } from "./kiro/session.js";
import { normalizeToolName } from "./kiro/tool-names.js";

// ── Types ────────────────────────────────────────────

interface KiroAdapterConfig {
  cwd?: string;
  agentName?: string;
  flushAgentName?: string;
  maxIdleMs?: number;
  autoApproveTools?: string[];
}

interface ThreadQueue {
  queue: Array<() => Promise<void>>;
  running: boolean;
}

// ── Factory ──────────────────────────────────────────

export const createKiroAgentAdapter: AgentAdapterFactory = (config) => {
  const opts: KiroAdapterConfig = {
    cwd: (config.cwd as string) ?? homedir(),
    agentName: (config.agentName as string) ?? "roundhouse",
    flushAgentName: (config.flushAgentName as string) ?? "roundhouse-flush",
    maxIdleMs: (config.maxIdleMs as number) ?? 30 * 60 * 1000,
    autoApproveTools: (config.autoApproveTools as string[]) ?? ["read", "grep", "glob", "web_fetch", "web_search"],
  };

  return createAdapter(opts);
};

// ── Adapter implementation ───────────────────────────

function createAdapter(config: KiroAdapterConfig): AgentAdapter {
  const sessionsDir = resolve(homedir(), ".roundhouse", "sessions");
  const store = new SessionStore({ sessionsDir, maxIdleMs: config.maxIdleMs });
  const threadQueues = new Map<string, ThreadQueue>();

  let mainProcess: AcpProcess | null = null;
  let initialized = false;
  let reaperInterval: ReturnType<typeof setInterval> | null = null;

  // Cached version (read once)
  const kiroVersion = getKiroCliVersion() ?? "unknown";

  // ── Process lifecycle ────────────────────────────────

  async function ensureProcess(): Promise<AcpProcess> {
    if (mainProcess && !mainProcess.client.isClosed) return mainProcess;

    mainProcess = spawnKiroCli({ agentName: config.agentName!, cwd: config.cwd! });

    // Initialize handshake
    await mainProcess.client.call<InitializeResult>("initialize", {
      protocolVersion: "1.0",
      clientInfo: { name: "roundhouse", version: "0.4.3" },
    });
    initialized = true;

    // Start idle reaper
    if (!reaperInterval) {
      reaperInterval = setInterval(reapIdleSessions, 60_000);
    }

    return mainProcess;
  }

  async function ensureSession(threadId: string): Promise<SessionEntry> {
    const existing = store.get(threadId);
    if (existing) return existing;

    const proc = await ensureProcess();

    // Try to resume a persisted session
    const persistedId = store.loadPersistedSessionId(threadId);
    if (persistedId) {
      try {
        await proc.client.call("session/load", { sessionId: persistedId });
        const entry: SessionEntry = {
          sessionId: persistedId,
          threadId,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          inFlight: false,
          contextTokens: null,
          contextWindow: null,
          model: null,
        };
        store.set(threadId, entry);
        return entry;
      } catch {
        // Session no longer valid — create new
      }
    }

    // Create new session
    const result = await proc.client.call<SessionNewResult>("session/new", {});
    const entry: SessionEntry = {
      sessionId: result.sessionId,
      threadId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      inFlight: false,
      contextTokens: null,
      contextWindow: null,
      model: null,
    };
    store.set(threadId, entry);
    return entry;
  }

  // ── Queue serialization ──────────────────────────────

  function enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    let tq = threadQueues.get(threadId);
    if (!tq) {
      tq = { queue: [], running: false };
      threadQueues.set(threadId, tq);
    }

    return new Promise<T>((resolve, reject) => {
      tq!.queue.push(async () => {
        try { resolve(await fn()); }
        catch (e) { reject(e); }
      });
      drainQueue(threadId);
    });
  }

  async function drainQueue(threadId: string): Promise<void> {
    const tq = threadQueues.get(threadId);
    if (!tq || tq.running) return;
    tq.running = true;
    while (tq.queue.length > 0) {
      const task = tq.queue.shift()!;
      await task();
    }
    tq.running = false;
  }

  // ── Core prompt logic ────────────────────────────────

  async function doPrompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    const session = await ensureSession(threadId);
    store.markInFlight(threadId, true);

    try {
      const proc = mainProcess!;
      const text = formatMessage(message);

      // Send prompt — events arrive as notifications
      const responsePromise = proc.client.call<void>("session/prompt", {
        sessionId: session.sessionId,
        text,
      });

      // Collect text chunks until complete
      let fullText = "";
      let done = false;

      const onTextChunk = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          fullText += params.text ?? "";
        }
      };

      const onPermission = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          // Auto-approve all tools in non-streaming mode
          proc.client.notify("permission/response", {
            tool_call_id: params.tool_call_id,
            decision: "approved",
          });
        }
      };

      const onComplete = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          done = true;
        }
      };

      const onSessionUpdate = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          store.updateContext(threadId, params.context_tokens ?? null, params.context_window ?? null, params.model);
        }
      };

      proc.client.on("text_chunk", onTextChunk);
      proc.client.on("permission_request", onPermission);
      proc.client.on("complete", onComplete);
      proc.client.on("session/update", onSessionUpdate);

      try {
        await responsePromise;
      } finally {
        proc.client.off("text_chunk", onTextChunk);
        proc.client.off("permission_request", onPermission);
        proc.client.off("complete", onComplete);
        proc.client.off("session/update", onSessionUpdate);
      }

      return { text: fullText };
    } finally {
      store.markInFlight(threadId, false);
    }
  }

  async function* doPromptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    const session = await ensureSession(threadId);
    store.markInFlight(threadId, true);

    try {
      const proc = mainProcess!;
      const text = formatMessage(message);

      // Use a channel pattern for yielding events
      const events: AgentStreamEvent[] = [];
      let done = false;
      let resolveWait: (() => void) | null = null;

      function push(ev: AgentStreamEvent) {
        events.push(ev);
        resolveWait?.();
      }

      const onTextChunk = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          push({ type: "text_delta", text: params.text ?? "" });
        }
      };

      const onToolCall = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          push({ type: "tool_start", toolName: normalizeToolName(params.title ?? params.tool_name ?? ""), toolCallId: params.tool_call_id });
        }
      };

      const onToolResult = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          push({ type: "tool_end", toolName: normalizeToolName(params.tool_name ?? ""), toolCallId: params.tool_call_id, isError: (params.exit_code ?? 0) !== 0 });
        }
      };

      const onPermission = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          // Auto-approve for now (HookManager integration in PR 2)
          proc.client.notify("permission/response", {
            tool_call_id: params.tool_call_id,
            decision: "approved",
          });
        }
      };

      const onComplete = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          if (params.stop_reason === "end_turn") {
            push({ type: "turn_end" });
          }
          push({ type: "agent_end" });
          done = true;
          resolveWait?.();
        }
      };

      const onSessionUpdate = (params: any) => {
        if (params?.sessionId === session.sessionId) {
          store.updateContext(threadId, params.context_tokens ?? null, params.context_window ?? null, params.model);
        }
      };

      proc.client.on("text_chunk", onTextChunk);
      proc.client.on("tool_call", onToolCall);
      proc.client.on("tool_result", onToolResult);
      proc.client.on("permission_request", onPermission);
      proc.client.on("complete", onComplete);
      proc.client.on("session/update", onSessionUpdate);

      // Fire the prompt (don't await — events stream in)
      proc.client.call("session/prompt", { sessionId: session.sessionId, text }).catch(() => {
        done = true;
        resolveWait?.();
      });

      try {
        while (!done || events.length > 0) {
          if (events.length > 0) {
            yield events.shift()!;
          } else if (!done) {
            await new Promise<void>((r) => { resolveWait = r; });
            resolveWait = null;
          }
        }
      } finally {
        proc.client.off("text_chunk", onTextChunk);
        proc.client.off("tool_call", onToolCall);
        proc.client.off("tool_result", onToolResult);
        proc.client.off("permission_request", onPermission);
        proc.client.off("complete", onComplete);
        proc.client.off("session/update", onSessionUpdate);
      }
    } finally {
      store.markInFlight(threadId, false);
    }
  }

  // ── Idle reaping ─────────────────────────────────────

  function reapIdleSessions(): void {
    const idle = store.getIdleSessions();
    for (const threadId of idle) {
      store.delete(threadId);
      threadQueues.delete(threadId);
    }
  }

  // ── Message formatting ───────────────────────────────

  function formatMessage(msg: AgentMessage): string {
    let text = msg.text;
    if (msg.attachments && msg.attachments.length > 0) {
      const manifest = msg.attachments.map((a) => ({
        id: a.id, type: a.mediaType, name: a.name,
        localPath: a.localPath, mime: a.mime,
        sizeBytes: a.sizeBytes, untrusted: true,
      }));
      text += `\n\nChat attachments saved locally. Inspect files with tools before making claims. Transcripts are approximate; use the raw file if exact wording matters.\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
    }
    return text;
  }

  // ── Public adapter interface ─────────────────────────

  const adapter: AgentAdapter = {
    name: "kiro",

    prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
      return enqueue(threadId, () => doPrompt(threadId, message));
    },

    promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
      // Channel-based approach: enqueue produces events, consumer reads them
      const events: AgentStreamEvent[] = [];
      let done = false;
      let error: Error | null = null;
      let resolveWait: (() => void) | null = null;

      // Start the stream inside the queue so it serializes with prompt()
      enqueue(threadId, async () => {
        try {
          for await (const ev of doPromptStream(threadId, message)) {
            events.push(ev);
            resolveWait?.();
          }
        } catch (e: any) {
          error = e;
        } finally {
          done = true;
          resolveWait?.();
        }
      });

      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<AgentStreamEvent>> {
              while (events.length === 0 && !done) {
                await new Promise<void>((r) => { resolveWait = r; });
                resolveWait = null;
              }
              if (events.length > 0) return { done: false, value: events.shift()! };
              if (error) throw error;
              return { done: true, value: undefined };
            },
            async return() {
              done = true;
              return { done: true, value: undefined };
            },
            async throw(e: any) {
              done = true;
              error = e;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    async abort(threadId: string): Promise<void> {
      const session = store.get(threadId);
      if (!session || !mainProcess) return;
      await mainProcess.client.call("session/cancel", { sessionId: session.sessionId }).catch(() => {});
    },

    async restart(threadId: string): Promise<void> {
      store.delete(threadId);
      threadQueues.delete(threadId);
    },

    async compact(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
      const session = store.get(threadId);
      if (!session || !mainProcess) return null;

      const before = session.contextTokens ?? 0;
      await mainProcess.client.call("_kiro.dev/commands/execute", {
        sessionId: session.sessionId,
        command: "/compact",
      });
      const after = store.get(threadId)?.contextTokens ?? null;
      return { tokensBefore: before, tokensAfter: after };
    },

    getInfo(threadId?: string): Record<string, unknown> {
      const session = threadId ? store.get(threadId) : undefined;
      return {
        version: kiroVersion,
        model: session?.model ?? config.agentName ?? "unknown",
        activeSessions: store.size,
        cwd: config.cwd,
        contextTokens: session?.contextTokens ?? null,
        contextWindow: session?.contextWindow ?? null,
        contextPercent: session?.contextTokens && session?.contextWindow
          ? Math.round((session.contextTokens / session.contextWindow) * 100)
          : null,
        hasMemoryExtension: false,
        memoryTools: [],
        extensions: [],
      };
    },

    async dispose(): Promise<void> {
      if (reaperInterval) {
        clearInterval(reaperInterval);
        reaperInterval = null;
      }
      if (mainProcess) {
        await shutdownProcess(mainProcess);
        mainProcess = null;
      }
      threadQueues.clear();
    },
  };

  return adapter;
}

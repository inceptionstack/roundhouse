/**
 * kiro-adapter.ts — Kiro CLI AgentAdapter for Roundhouse
 *
 * Drives kiro-cli over ACP (Agent Control Protocol) via JSON-RPC stdio.
 * Extends BaseAdapter to fulfill the fixed interface contract.
 *
 * Architecture:
 * - One kiro-cli process hosts all sessions (spawned lazily on first prompt)
 * - Sessions are per-thread, serialized via a queue to prevent concurrent prompts
 * - ACP events are mapped to AgentStreamEvent for the gateway
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent, AdapterInfo, MessageContext } from "../../types.js";
import { ROUNDHOUSE_VERSION } from "../../config.js";
import { BaseAdapter } from "../base-adapter.js";
import { spawnKiroCli, shutdownProcess, getKiroCliVersion, type AcpProcess, type InitializeResult, type SessionNewResult } from "./acp/index.js";
import { SessionStore, type SessionEntry } from "./session.js";
import { normalizeToolName } from "./tool-names.js";

// ── Types ────────────────────────────────────────────

interface KiroAdapterConfig {
  cwd: string;
  agentName: string;
  flushAgentName: string;
  maxIdleMs: number;
  autoApproveTools: string[];
}

// ── Factory ──────────────────────────────────────────

export const createKiroAgentAdapter: AgentAdapterFactory = (config) => {
  return new KiroAdapter({
    cwd: (config.cwd as string) ?? homedir(),
    agentName: (config.agentName as string) ?? "roundhouse",
    flushAgentName: (config.flushAgentName as string) ?? "roundhouse-flush",
    maxIdleMs: (config.maxIdleMs as number) ?? 30 * 60 * 1000,
    autoApproveTools: (config.autoApproveTools as string[]) ?? ["read", "grep", "glob", "web_fetch", "web_search"],
  });
};

// ── KiroAdapter ──────────────────────────────────────

class KiroAdapter extends BaseAdapter {
  readonly name = "kiro";

  private readonly config: KiroAdapterConfig;
  private readonly store: SessionStore;
  private readonly threadQueues = new Map<string, { queue: Array<() => Promise<void>>; running: boolean }>();
  private readonly kiroVersion: string;

  private mainProcess: AcpProcess | null = null;
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: KiroAdapterConfig) {
    super();
    this.config = config;
    const sessionsDir = resolve(homedir(), ".roundhouse", "sessions");
    this.store = new SessionStore({ sessionsDir, maxIdleMs: config.maxIdleMs });
    this.kiroVersion = getKiroCliVersion() ?? "unknown";
  }

  // ── Required: prompt ─────────────────────────────────

  async prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    return this.enqueue(threadId, () => this.doPrompt(threadId, message));
  }

  // ── Required: promptStream ───────────────────────────

  promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    const events: AgentStreamEvent[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;
    let innerIterator: AsyncIterator<AgentStreamEvent> | null = null;

    this.enqueue(threadId, async () => {
      try {
        const gen = this.doPromptStream(threadId, message);
        innerIterator = gen[Symbol.asyncIterator]();
        let result = await innerIterator.next();
        while (!result.done && !done) {
          events.push(result.value);
          resolveWait?.();
          result = await innerIterator.next();
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
            innerIterator?.return?.();
            return { done: true, value: undefined } as IteratorResult<AgentStreamEvent>;
          },
          async throw(e: any) {
            done = true;
            error = e;
            return { done: true, value: undefined } as IteratorResult<AgentStreamEvent>;
          },
        };
      },
    };
  }

  // ── Required: dispose ────────────────────────────────

  async dispose(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
    if (this.mainProcess) {
      await shutdownProcess(this.mainProcess);
      this.mainProcess = null;
    }
    this.threadQueues.clear();
  }

  // ── Optional overrides ───────────────────────────────

  async abort(threadId: string): Promise<void> {
    const session = this.store.get(threadId);
    if (!session || !this.mainProcess) return;
    await this.mainProcess.client.call("session/cancel", { sessionId: session.sessionId }).catch(() => {});
  }

  async restart(threadId: string): Promise<void> {
    this.store.delete(threadId);
    this.threadQueues.delete(threadId);
  }

  async compact(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
    const session = this.store.get(threadId);
    if (!session || !this.mainProcess) return null;

    const before = session.contextTokens ?? 0;
    await this.mainProcess.client.call("_kiro.dev/commands/execute", {
      sessionId: session.sessionId,
      command: "/compact",
    });
    const after = this.store.get(threadId)?.contextTokens ?? null;
    return { tokensBefore: before, tokensAfter: after };
  }

  getInfo(threadId?: string): AdapterInfo {
    const session = threadId ? this.store.get(threadId) : undefined;
    return {
      version: this.kiroVersion,
      model: session?.model ?? this.config.agentName ?? "unknown",
      activeSessions: this.store.size,
      cwd: this.config.cwd,
      contextTokens: session?.contextTokens ?? null,
      contextWindow: session?.contextWindow ?? null,
      contextPercent: session?.contextTokens && session?.contextWindow
        ? Math.round((session.contextTokens / session.contextWindow) * 100)
        : null,
      hasMemoryExtension: false,
      memoryTools: [],
      extensions: [],
    };
  }

  prepareMessage(_threadId: string, message: AgentMessage, _context: MessageContext): AgentMessage {
    return message;
  }

  // ── Private: process lifecycle ───────────────────────

  private async ensureProcess(): Promise<AcpProcess> {
    if (this.mainProcess && !this.mainProcess.client.isClosed) return this.mainProcess;

    this.mainProcess = spawnKiroCli({ agentName: this.config.agentName, cwd: this.config.cwd });

    await this.mainProcess.client.call<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { terminal: true },
      clientInfo: { name: "roundhouse", version: ROUNDHOUSE_VERSION },
    });

    if (!this.reaperInterval) {
      this.reaperInterval = setInterval(() => this.reapIdleSessions(), 60_000);
    }

    return this.mainProcess;
  }

  private async ensureSession(threadId: string): Promise<SessionEntry> {
    const existing = this.store.get(threadId);
    if (existing) return existing;

    const proc = await this.ensureProcess();

    const persistedId = this.store.loadPersistedSessionId(threadId);
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
        this.store.set(threadId, entry);
        return entry;
      } catch {
        // Session no longer valid — create new
      }
    }

    const result = await proc.client.call<SessionNewResult>("session/new", { cwd: this.config.cwd, mcpServers: [] });
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
    this.store.set(threadId, entry);
    return entry;
  }

  // ── Private: prompt logic ────────────────────────────

  private async doPrompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    const session = await this.ensureSession(threadId);
    this.store.markInFlight(threadId, true);

    try {
      const proc = this.mainProcess!;
      const text = this.formatMessage(message);

      let fullText = "";

      const onSessionUpdate = (params: any) => {
        if (params?.sessionId !== session.sessionId) return;
        const update = params.update;
        if (!update) return;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
          fullText += update.content.text;
        }
      };

      const onMetadata = (params: any) => {
        if (params?.sessionId !== session.sessionId) return;
        const pct = params.contextUsagePercentage;
        if (pct != null) {
          const window = 200000;
          const tokens = Math.round((pct / 100) * window);
          this.store.updateContext(threadId, tokens, window, params.model ?? null);
        }
      };

      proc.client.on("session/update", onSessionUpdate);
      proc.client.on("_kiro.dev/session/update", onSessionUpdate);
      proc.client.on("_kiro.dev/metadata", onMetadata);

      try {
        await proc.client.call<any>("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        });
      } finally {
        proc.client.off("session/update", onSessionUpdate);
        proc.client.off("_kiro.dev/session/update", onSessionUpdate);
        proc.client.off("_kiro.dev/metadata", onMetadata);
      }

      return { text: fullText };
    } finally {
      this.store.markInFlight(threadId, false);
    }
  }

  private async *doPromptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    const session = await this.ensureSession(threadId);
    this.store.markInFlight(threadId, true);

    try {
      const proc = this.mainProcess!;
      const text = this.formatMessage(message);

      const events: AgentStreamEvent[] = [];
      let done = false;
      let promptError: Error | null = null;
      let resolveWait: (() => void) | null = null;

      function push(ev: AgentStreamEvent) {
        events.push(ev);
        resolveWait?.();
      }

      const onSessionUpdate = (params: any) => {
        if (params?.sessionId !== session.sessionId) return;
        const update = params.update;
        if (!update) return;
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content?.text) {
              push({ type: "text_delta", text: update.content.text });
            }
            break;
          case "tool_call":
            push({ type: "tool_start", toolName: normalizeToolName(update.title ?? ""), toolCallId: update.toolCallId ?? "" });
            break;
          case "tool_call_update":
            push({ type: "tool_end", toolName: normalizeToolName(update.title ?? ""), toolCallId: update.toolCallId ?? "", isError: false });
            break;
        }
      };

      const onMetadata = (params: any) => {
        if (params?.sessionId !== session.sessionId) return;
        const pct = params.contextUsagePercentage;
        if (pct != null) {
          const window = 200000;
          const tokens = Math.round((pct / 100) * window);
          this.store.updateContext(threadId, tokens, window, params.model ?? null);
        }
      };

      proc.client.on("session/update", onSessionUpdate);
      proc.client.on("_kiro.dev/session/update", onSessionUpdate);
      proc.client.on("_kiro.dev/metadata", onMetadata);

      // Fire the prompt (don't await — events stream in)
      proc.client.call<any>("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] }).then(() => {
        push({ type: "turn_end" });
        push({ type: "agent_end" });
        done = true;
        resolveWait?.();
      }).catch((err) => {
        push({ type: "agent_end" });
        done = true;
        promptError = err;
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
        if (promptError) throw promptError;
      } finally {
        proc.client.off("session/update", onSessionUpdate);
        proc.client.off("_kiro.dev/session/update", onSessionUpdate);
        proc.client.off("_kiro.dev/metadata", onMetadata);
      }
    } finally {
      this.store.markInFlight(threadId, false);
    }
  }

  // ── Private: utilities ───────────────────────────────

  private enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    let tq = this.threadQueues.get(threadId);
    if (!tq) {
      tq = { queue: [], running: false };
      this.threadQueues.set(threadId, tq);
    }

    return new Promise<T>((resolve, reject) => {
      tq!.queue.push(async () => {
        try { resolve(await fn()); }
        catch (e) { reject(e); }
      });
      this.drainQueue(threadId);
    });
  }

  private async drainQueue(threadId: string): Promise<void> {
    const tq = this.threadQueues.get(threadId);
    if (!tq || tq.running) return;
    tq.running = true;
    while (tq.queue.length > 0) {
      const task = tq.queue.shift()!;
      await task();
    }
    tq.running = false;
  }

  private reapIdleSessions(): void {
    const idle = this.store.getIdleSessions();
    for (const threadId of idle) {
      this.store.delete(threadId);
      this.threadQueues.delete(threadId);
    }
  }

  private formatMessage(msg: AgentMessage): string {
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
}

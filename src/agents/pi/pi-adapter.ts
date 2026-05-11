/**
 * agents/pi/pi-adapter.ts — Pi agent adapter
 *
 * Wraps pi's SDK (createAgentSession) as an AgentAdapter.
 * One persistent session per thread, stored at:
 *   ~/.roundhouse/sessions/<thread_id>/<session>.jsonl
 *
 * TODO: Migrate from factory+object-literal to class extending BaseAdapter
 *       (separate PR — large file, needs careful testing)
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
} from "@earendil-works/pi-coding-agent";

import type { AgentAdapter, AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent, MessageContext } from "../../types";
import { formatMessage, extractCustomMessage, customContentToText } from "./message-format";
import { isToolPairingError, repairSessionFile } from "../shared/session-repair";
import { SESSIONS_DIR } from "../../config";
import { DEBUG_STREAM, threadIdToDir } from "../../util";

interface SessionEntry {
  session: AgentSession;
  lastUsed: number;
  inFlight: number;
  /** Captured config used to recreate the session after disk-level repair. */
  threadId?: string;
}

const DEFAULT_SESSIONS_DIR = SESSIONS_DIR;
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
  let memoryCapabilities: { hasMemoryExtension: boolean; memoryTools: string[]; extensions: string[] } | undefined;
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
    // @earendil-works/pi-coding-agent version bundled via `latest` in
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


  /**
   * Callback shape for re-subscribing after a mid-turn session swap (auto-repair).
   * Caller provides:
   *   - `subscribe(session)` — re-attach the caller's event handler to the new session
   *   - `unsubscribeOld()` — detach from the old session before it's disposed
   *
   * Ordering inside runPromptAndFollowUps on repair:
   *   1. unsubscribeOld() on the pre-repair session
   *   2. dispose old session
   *   3. repair + reload
   *   4. subscribe(newSession) so the retry's events reach the caller
   */
  interface Resubscribe {
    unsubscribeOld: () => void;
    subscribe: (session: AgentSession) => void;
  }

  async function runPromptAndFollowUps(
    entry: SessionEntry,
    text: string,
    onDraining?: () => void,
    onDrainComplete?: () => void,
    resubscribe?: Resubscribe,
  ): Promise<void> {
    entry.inFlight++;
    // Track whether *this specific prompt call* has already retried after a
    // repair. Prevents retry loops within one turn, but doesn't latch the
    // SessionEntry for its whole lifetime — a future prompt on the same
    // long-lived entry can still auto-repair if new corruption appears (F3).
    let repairedThisCall = false;
    try {
      try {
        await entry.session.prompt(text);
      } catch (err) {
        // Auto-recover from session-history corruption (orphaned toolCall/toolResult
        // pairs caused by crashed/aborted tools mid-session). Repair the .jsonl on
        // disk, reload the session, retry once. Do NOT loop — if the repaired file
        // still fails, something else is wrong; surface the original error.
        if (!isToolPairingError(err) || repairedThisCall) {
          throw err;
        }
        repairedThisCall = true;
        const sessionFile = entry.session.sessionFile;
        if (!sessionFile) {
          throw err; // in-memory session — nothing to repair on disk
        }
        console.warn(`[pi-agent] tool-pairing error detected on session ${sessionFile} — attempting repair`);
        const report = repairSessionFile(sessionFile);
        if (!report.repaired) {
          // File had no orphans but model still rejected — not our problem to fix.
          console.warn(`[pi-agent] repair found no orphans; re-throwing original error`);
          throw err;
        }
        console.warn(
          `[pi-agent] repaired session: dropped ${report.droppedEntryIds.length} entries ` +
          `(${report.droppedToolCallIds.length} toolCalls, ${report.droppedToolResultIds.length} toolResults). ` +
          `Backup: ${report.backupPath}`
        );
        // Detach caller's subscriber from the dying session before we swap, so
        // it doesn't receive events from (or prevent GC of) the old session.
        resubscribe?.unsubscribeOld();
        // Reload session FIRST (before disposing old) so that if
        // SessionManager.open / createAgentSession throws, we don't leave the
        // SessionEntry with a disposed-but-still-referenced session that
        // subsequent prompts would reuse. Old session stays alive as fallback
        // until the new one is fully constructed.
        let reloaded: { session: AgentSession };
        try {
          reloaded = await reloadSession(entry, sessionFile);
        } catch (reloadErr) {
          console.warn(`[pi-agent] reloadSession failed after repair — keeping old session, re-subscribing`, reloadErr);
          // Re-attach to the old session so the caller isn't silently orphaned.
          resubscribe?.subscribe(entry.session);
          throw err; // surface original tool-pairing error — repair didn't help
        }
        // Now it's safe to dispose the old session: we have a working replacement.
        const oldSession = entry.session;
        entry.session = reloaded.session;
        try {
          oldSession.dispose();
        } catch (disposeErr) {
          console.warn(`[pi-agent] old session dispose failed (non-fatal):`, disposeErr);
        }
        // Re-attach caller's subscriber to the new session so the retry's
        // text_delta/tool events flow through (F1).
        resubscribe?.subscribe(entry.session);
        await entry.session.prompt(text);
      }
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
    } finally {
      entry.inFlight--;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Rebuild just the AgentSession for an existing SessionEntry. Used after
   * on-disk session repair — we need pi-ai to re-read the fixed .jsonl, which
   * means a fresh SessionManager + createAgentSession call.
   *
   * Intentionally does NOT re-run one-time setup (memory-capability detection,
   * tool registration) — those belong to createSession(). This is a narrow
   * "replace the pi session object" operation.
   *
   * Opens the *exact* repaired file by path (not continueRecent) to avoid
   * picking up a different recent session file.
   */
  async function reloadSession(entry: SessionEntry, repairedSessionFile: string): Promise<{ session: AgentSession }> {
    const threadId = entry.threadId;
    if (!threadId) {
      throw new Error("reloadSession: entry has no threadId; cannot reload");
    }
    const dirName = threadIdToDir(threadId);
    const threadDir = join(sessionsDir, dirName);
    // Open the specific repaired file by path so we don't race with other
    // session files in the directory (F4).
    const sessionManager = SessionManager.open(repairedSessionFile, threadDir, cwd);
    console.log(`[pi-agent] reloaded session for ${threadId}: ${sessionManager.getSessionFile()}`);
    const result = await createAgentSession({
      cwd,
      sessionManager,
      authStorage,
      modelRegistry,
    });
    return { session: result.session };
  }

  async function createSession(threadId: string): Promise<SessionEntry> {
    const dirName = threadIdToDir(threadId);
    const threadDir = join(sessionsDir, dirName);
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

    const entry: SessionEntry = { session: result.session, lastUsed: Date.now(), inFlight: 0, threadId };
    sessions.set(threadId, entry);

    // Detect memory capabilities from loaded extensions (first session only)
    if (!memoryCapabilities) {
      const allTools = new Set<string>();
      const extNames: string[] = [];
      for (const ext of result.extensionsResult.extensions) {
        extNames.push(ext.sourceInfo?.source || ext.path);
        for (const toolName of ext.tools.keys()) {
          allTools.add(toolName);
        }
      }
      memoryCapabilities = {
        hasMemoryExtension: allTools.has("memory_search") || allTools.has("memory_remember"),
        memoryTools: ["memory_search", "memory_remember", "memory_forget", "memory_lessons", "memory_stats"]
          .filter(t => allTools.has(t)),
        extensions: extNames,
      };
      if (memoryCapabilities.hasMemoryExtension) {
        console.log(`[pi-agent] memory extension detected (tools: ${memoryCapabilities.memoryTools.join(", ")})`);
      } else {
        console.log(`[pi-agent] no memory extension detected — roundhouse memory will manage`);
      }

      // Warn about pi extensions that bridge a chat platform directly.
      // They hijack agent_start/message_update/agent_end and short-circuit
      // Roundhouse's streaming pipeline — Telegram shows "typing" forever.
      const conflicting = extNames.filter((n) => /pi-telegram(\b|[\/\\])/i.test(n));
      if (conflicting.length > 0) {
        const lines = [
          "",
          "\u26a0\ufe0f  CONFLICT: detected pi extension(s) that bridge a chat platform directly:",
          ...conflicting.map((n) => `   - ${n}`),
          "   Roundhouse already drives Telegram. Loading a bridge extension inside",
          "   the pi session causes lost replies (typing indicator without text).",
          "   Remove the extension from ~/.pi/agent/extensions or pi config and restart.",
          "",
        ];
        for (const line of lines) console.warn(line);
      }
    }

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
      if (entry.inFlight > 0) continue; // skip busy sessions
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
  const adapter: AgentAdapter = {
    name: "pi",

    async prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
      return enqueue(threadId, () => doPrompt(threadId, formatMessage(message)));
    },

    async promptWithModel(threadId: string, message: AgentMessage, modelId: string): Promise<AgentResponse> {
      return enqueue(threadId, async () => {
        const entry = await getOrCreate(threadId);
        const currentModel = entry.session.model;

        // Resolve the target model (format: "provider/model-id")
        let targetModel;
        const [provider, ...rest] = modelId.split("/");
        const id = rest.join("/");
        if (provider && id) {
          targetModel = modelRegistry.find(provider, id);
        }

        if (!targetModel) {
          console.warn(`[pi-agent] flush model "${modelId}" not found, using default`);
          return doPrompt(threadId, formatMessage(message));
        }

        // Verify auth is available for the target model
        if (!modelRegistry.hasConfiguredAuth(targetModel)) {
          console.warn(`[pi-agent] no auth for flush model "${modelId}", using default`);
          return doPrompt(threadId, formatMessage(message));
        }

        // Swap model in-memory only (no persistence to settings.json or session log).
        // This avoids a crash-window where settings could be left on the flush model.
        const agentState = (entry.session as any).agent?.state;
        if (!agentState) {
          console.warn(`[pi-agent] cannot access agent state for model swap, using default`);
          return doPrompt(threadId, formatMessage(message));
        }

        agentState.model = targetModel;
        console.log(`[pi-agent] switched to flush model (in-memory): ${modelId}`);

        try {
          return await doPrompt(threadId, formatMessage(message));
        } finally {
          // Restore original model (in-memory only) — even if undefined
          agentState.model = currentModel;
        }
      });
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

            // Extracted subscriber handler so it can be re-attached after an
            // auto-repair session swap (captures only the enqueue closure,
            // not `entry.session`, so it's safe to re-use).
            const handleEvent = (event: AgentSessionEvent) => {
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
                } else if (event.type === "message_end") {
                  // Pi records provider failures (auth, throttling, etc.) on the
                  // assistant message instead of throwing — surface them.
                  const msg = (event as any).message;
                  if (msg?.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
                    streamEvent = { type: "model_error", message: msg.errorMessage };
                  }
                }
              }

              if (streamEvent) {
                eventQueue.push(streamEvent);
                resolve?.();
              }
            };

            // Subscription is mutable so auto-repair can swap it when the
            // session is reloaded mid-prompt.
            let unsub = entry.session.subscribe(handleEvent);

            try {
              await runPromptAndFollowUps(
                entry,
                text,
                () => {
                  eventQueue.push({ type: "draining" });
                  resolve?.();
                },
                () => {
                  eventQueue.push({ type: "drain_complete" });
                  resolve?.();
                },
                {
                  unsubscribeOld: () => { try { unsub(); } catch { /* ignore */ } },
                  subscribe: (newSession) => { unsub = newSession.subscribe(handleEvent); },
                },
              );
              // Final drain — guarantees all subscriber events have been delivered
              // before we unsubscribe below.
              await drainSessionEvents(entry.session);
            } finally {
              try { unsub(); } catch { /* ignore */ }
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
        memoryCapabilities = undefined; // re-detect on next session creation
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

    async compactWithModel(threadId: string, modelId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
      return enqueue(threadId, async () => {
        const entry = sessions.get(threadId);
        if (!entry) return null;

        const agentState = (entry.session as any).agent?.state;
        let currentModel: any;
        let modelSwapped = false;

        // Resolve and swap model for compact
        if (!agentState) {
          console.warn(`[pi-agent] cannot access agent state for compact model swap, using default`);
        } else {
          const [provider, ...rest] = modelId.split("/");
          const id = rest.join("/");
          const targetModel = (provider && id) ? modelRegistry.find(provider, id) : null;
          if (!targetModel) {
            console.warn(`[pi-agent] compact model "${modelId}" not found, using default`);
          } else if (!modelRegistry.hasConfiguredAuth(targetModel)) {
            console.warn(`[pi-agent] no auth for compact model "${modelId}", using default`);
          } else {
            currentModel = agentState.model;
            agentState.model = targetModel;
            modelSwapped = true;
            console.log(`[pi-agent] compact using model (in-memory): ${modelId}`);
          }
        }

        try {
          const result = await entry.session.compact();
          const usage = entry.session.getContextUsage();
          return {
            tokensBefore: result.tokensBefore,
            tokensAfter: usage?.tokens ?? null,
          };
        } finally {
          if (modelSwapped) {
            agentState.model = currentModel;
          }
        }
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
      let hasActiveSession = false;
      let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
      const threadEntry = threadId ? sessions.get(threadId) : undefined;

      if (threadEntry) {
        const model = threadEntry.session.model;
        if (model) modelInfo = `${model.provider}/${model.id}`;
        contextUsage = threadEntry.session.getContextUsage() ?? undefined;
        hasActiveSession = true;
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

      // Read configured model from settings.json (used for fallback + configuredModel field)
      let configuredModel = "";
      try {
        const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (settings.defaultProvider && settings.defaultModel) {
          configuredModel = `${settings.defaultProvider}/${settings.defaultModel}`;
        }
      } catch {}

      if (!modelInfo && configuredModel) {
        modelInfo = configuredModel;
      }

      // Read agent version
      let version = "unknown";
      try {
        const piPkgPath = join(__piAdapterDir, "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
        version = JSON.parse(readFileSync(piPkgPath, "utf8")).version;
      } catch {}

      return {
        version,
        model: modelInfo ?? "unknown",
        hasActiveSession,
        configuredModel: configuredModel || modelInfo || "unknown",
        activeSessions: sessions.size,
        cwd,
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? null,
        contextPercent: contextUsage?.percent ?? null,
        hasMemoryExtension: memoryCapabilities?.hasMemoryExtension ?? null,
        memoryTools: memoryCapabilities?.memoryTools ?? [],
        extensions: memoryCapabilities?.extensions ?? [],
      };
    },

    prepareMessage(_threadId: string, message: AgentMessage, _context: MessageContext): AgentMessage {
      return message;
    },
  };

  async function doPrompt(threadId: string, text: string): Promise<AgentResponse> {
    const entry = await getOrCreate(threadId);
    entry.lastUsed = Date.now();

    let fullText = "";
    const handleEvent = (event: AgentSessionEvent) => {
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
    };
    let unsub = entry.session.subscribe(handleEvent);

    try {
      await runPromptAndFollowUps(entry, text, undefined, undefined, {
        unsubscribeOld: () => { try { unsub(); } catch { /* ignore */ } },
        subscribe: (newSession) => { unsub = newSession.subscribe(handleEvent); },
      });
      await drainSessionEvents(entry.session);
    } finally {
      try { unsub(); } catch { /* ignore */ }
    }

    return { text: fullText };
  }

  return adapter;
};

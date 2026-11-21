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

import { mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __piAdapterDir = dirname(fileURLToPath(import.meta.url));

import {
  createAgentSession,
  DefaultResourceLoader,
  detectSupportedImageMimeTypeFromFile,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { AgentAdapter, AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent, MessageContext } from "../../types";
import { formatMessage, extractCustomMessage, customContentToText } from "./message-format";
import { isToolPairingError } from "../shared/error-classifiers";
import { repairSessionFile } from "../shared/session-repair";
import { softResetSessionFile, type SoftResetReport } from "../shared/session-soft-reset";
import { SESSIONS_DIR } from "../../config";
import { COMPACT_HEADROOM_TOKENS } from "../../memory/policy";
import { DEBUG_STREAM, threadIdToDir } from "../../util";

interface SessionEntry {
  session: AgentSession;
  lastUsed: number;
  inFlight: number;
  /** Captured config used to recreate the session after disk-level repair. */
  threadId?: string;
  /** Standing context this session's system prompt was built with. */
  standingText?: string;
  /** "/new" marker to remove once this fresh session has a turn on disk. */
  freshMarker?: string;
}

/** Dropped in a thread's session directory by /new: the next session starts empty. */
const NEW_SESSION_MARKER = ".new-session";

/** Images passed to the model directly per message; further ones stay as files. */
const MAX_INLINE_IMAGES = 5;

const DEFAULT_SESSIONS_DIR = SESSIONS_DIR;
const DEFAULT_MAX_IDLE_MS = 30 * 60 * 1000;

export const createPiAgentAdapter: AgentAdapterFactory = (config) => {
  const cwd = (config.cwd as string) ?? process.cwd();
  const sessionsDir =
    (config.sessionDir as string) ?? DEFAULT_SESSIONS_DIR;
  const maxIdleMs =
    (config.maxIdleMs as number) ?? DEFAULT_MAX_IDLE_MS;

  // pi >= 0.80.8 replaced AuthStorage + ModelRegistry with one async
  // ModelRuntime (auth.json + models.json under ~/.pi/agent). The adapter
  // factory is synchronous, so the runtime is created on first use and shared
  // by every session. A failed create is not cached, so the next prompt retries.
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  function getModelRuntime(): Promise<ModelRuntime> {
    if (!modelRuntimePromise) {
      modelRuntimePromise = ModelRuntime.create().catch((err) => {
        modelRuntimePromise = undefined;
        throw err;
      });
    }
    return modelRuntimePromise;
  }
  // Persona and tool notes from the gateway, carried in the system prompt
  // instead of in front of every user message. Absent for callers that give
  // none (cron runs, `roundhouse agent`).
  const standingContext = typeof config.standingContext === "function"
    ? (config.standingContext as () => string)
    : undefined;
  const currentStandingText = (): string => {
    if (!standingContext) return "";
    try { return standingContext() ?? ""; } catch (err) {
      console.warn(`[pi-agent] standing context unavailable:`, (err as Error).message);
      return "";
    }
  };

  /**
   * Options for createAgentSession. With a standing context this builds the
   * same resource loader pi would build by default, plus one extra block at
   * the end of the system prompt. The block is read each time the loader
   * reloads, so `session.reload()` picks up an edited soul.md or tools.md.
   */
  async function sessionOptions(sessionManager: SessionManager) {
    const base = { cwd, sessionManager, modelRuntime: await getModelRuntime() };
    if (!standingContext) return { options: base, standingText: undefined };
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    let standingText = "";
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      appendSystemPromptOverride: (appended) => {
        standingText = currentStandingText();
        return standingText ? [...appended, standingText] : appended;
      },
    });
    await resourceLoader.reload();
    return { options: { ...base, settingsManager, resourceLoader }, standingText };
  }

  /** Rebuild the system prompt when the standing context changed on disk. */
  async function refreshStandingContext(entry: SessionEntry): Promise<void> {
    if (!standingContext || entry.standingText === undefined) return;
    const now = currentStandingText();
    if (now === entry.standingText) return;
    try {
      await entry.session.reload();
      entry.standingText = now;
      console.log(`[pi-agent] standing context changed; system prompt rebuilt for ${entry.threadId ?? "?"}`);
    } catch (err) {
      console.warn(`[pi-agent] could not rebuild the system prompt:`, (err as Error).message);
    }
  }

  /**
   * Whether the conversation fits in another model's context window, with
   * room for the summary. A flush or compaction model with a smaller window
   * than the conversation model cannot take a conversation that has outgrown
   * it; the provider would reject the request.
   */
  function fitsModel(session: AgentSession, model: { contextWindow?: number }): boolean {
    const used = session.getContextUsage()?.tokens;
    if (!used || !model.contextWindow) return true;
    return used + COMPACT_HEADROOM_TOKENS <= model.contextWindow;
  }

  const sessions = new Map<string, SessionEntry>();
  const creating = new Map<string, Promise<SessionEntry>>();
  let memoryCapabilities: { hasMemoryExtension: boolean; memoryTools: string[]; extensions: string[] } | undefined;
  let reapInterval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  /**
   * Wait until the session has nothing left to do.
   *
   * Since pi 1.0, `session.prompt()` resolves only after the whole run has
   * settled: automatic retries, compaction, follow-ups queued by `agent_end`
   * handlers and the `agent_settled` handlers are all inside it. What it does
   * not cover is a run an extension starts after that point (for example
   * `pi.sendMessage(..., { triggerTurn: true })` while idle). `isIdle` is false
   * for those too, so loop on the public `waitForIdle()` until it holds.
   *
   * This replaces the pre-1.0 workaround that awaited the private
   * `_agentEventQueue` field and drove `agent.continue()` by hand; that field
   * no longer exists and the session now drains its own queues.
   */
  async function waitUntilIdle(session: AgentSession): Promise<void> {
    while (!session.isIdle) {
      await session.waitForIdle();
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

  /**
   * Image attachments as model input. An image used to reach the model only
   * as a path in the attachment manifest, so seeing a screenshot cost an
   * extra tool call, and only if the model chose to make it. The file is
   * sniffed rather than trusted: a photo sent "as file" arrives typed as a
   * file, and a text file can be named .png. pi resizes what it is given.
   */
  async function loadImages(message: AgentMessage): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const a of message.attachments ?? []) {
      if (images.length >= MAX_INLINE_IMAGES) break;
      try {
        const mimeType = await detectSupportedImageMimeTypeFromFile(a.localPath);
        if (!mimeType) continue;
        images.push({ type: "image", data: (await readFile(a.localPath)).toString("base64"), mimeType });
        a.inline = true;
      } catch (err) {
        console.warn(`[pi-agent] could not attach image ${a.name}:`, (err as Error).message);
      }
    }
    return images;
  }

  async function runPromptAndFollowUps(
    entry: SessionEntry,
    text: string,
    onDraining?: () => void,
    onDrainComplete?: () => void,
    resubscribe?: Resubscribe,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    const promptOptions = images && images.length > 0 ? { images } : undefined;
    entry.inFlight++;
    // Track whether *this specific prompt call* has already retried after a
    // repair. Prevents retry loops within one turn, but doesn't latch the
    // SessionEntry for its whole lifetime — a future prompt on the same
    // long-lived entry can still auto-repair if new corruption appears (F3).
    let repairedThisCall = false;
    try {
      try {
        // A run an extension started on its own may still be going. prompt()
        // would throw "already processing" or, during agent_settled handlers,
        // defer the prompt and return before it ran.
        await waitUntilIdle(entry.session);
        await refreshStandingContext(entry);
        await entry.session.prompt(text, promptOptions);
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
        await entry.session.prompt(text, promptOptions);
      }
      // The subscriber must stay attached until the session is fully idle,
      // or a run started by an extension after prompt() resolved would post
      // its output to nobody (Telegram shows a review bubble, then silence).
      let notifiedDraining = false;
      if (!entry.session.isIdle) {
        if (onDraining) {
          onDraining();
          notifiedDraining = true;
        }
        await waitUntilIdle(entry.session);
      }

      if (notifiedDraining && onDrainComplete) {
        onDrainComplete();
      }
      // The fresh session now has a turn on disk and is the newest transcript.
      if (entry.freshMarker && entry.session.sessionFile && existsSync(entry.session.sessionFile)) {
        try { rmSync(entry.freshMarker, { force: true }); } catch { /* next start retries */ }
        entry.freshMarker = undefined;
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
    const { options, standingText } = await sessionOptions(sessionManager);
    const result = await createAgentSession(options);
    entry.standingText = standingText;
    return { session: result.session };
  }

  async function createSession(threadId: string): Promise<SessionEntry> {
    const dirName = threadIdToDir(threadId);
    const threadDir = join(sessionsDir, dirName);
    await mkdir(threadDir, { recursive: true });

    let sessionManager: SessionManager;
    // /new left a marker: start an empty session instead of reopening the
    // newest transcript. The marker stays until the new session has a turn
    // on disk, so a restart in between does not fall back to the old one.
    const markerPath = join(threadDir, NEW_SESSION_MARKER);
    const startFresh = existsSync(markerPath);

    try {
      if (startFresh) throw new Error("start fresh");
      // continueRecent creates a session when the directory has none, so
      // look first to report which of the two happened.
      const hadSession = readdirSync(threadDir).some((f) => f.endsWith(".jsonl"));
      sessionManager = SessionManager.continueRecent(cwd, threadDir);
      console.log(
        `[pi-agent] ${hadSession ? "resuming" : "new"} session for ${threadId}: ${sessionManager.getSessionFile()}`
      );
    } catch {
      sessionManager = SessionManager.create(cwd, threadDir);
      console.log(
        `[pi-agent] new session for ${threadId}: ${sessionManager.getSessionFile()}`
      );
    }

    const { options, standingText } = await sessionOptions(sessionManager);
    const result = await createAgentSession(options);

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

    const entry: SessionEntry = { session: result.session, lastUsed: Date.now(), inFlight: 0, threadId, standingText };
    if (startFresh) entry.freshMarker = markerPath;
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
    // After dispose() (gateway shutdown) a queued prompt must fail, not open
    // a fresh session and start a model call the exit is about to kill.
    if (disposed) throw new Error("pi adapter is shut down");
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
   * Compact a thread's session, optionally with another model for the summary.
   *
   * Thinking is switched off for the summary in both cases: summarization
   * gains nothing from reasoning, pays for it, and the thinking budget eats
   * into the output limit the summary has to fit in. Model and thinking level
   * are swapped in memory and restored; `setModel()` / `setThinkingLevel()`
   * would write the change into the transcript.
   */
  function compactSession(threadId: string, modelId: string | undefined): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
    return enqueue(threadId, async () => {
      const entry = sessions.get(threadId);
      if (!entry) return null;

      const agentState = (entry.session as any).agent?.state;
      let currentModel: any;
      let currentThinkingLevel: any;
      let modelSwapped = false;
      let thinkingSwapped = false;

      if (!agentState) {
        console.warn(`[pi-agent] cannot access agent state for compact, using the session's model and thinking level`);
      } else {
        if (modelId) {
          const modelRuntime = await getModelRuntime();
          const [provider, ...rest] = modelId.split("/");
          const id = rest.join("/");
          const targetModel = (provider && id) ? modelRuntime.getModel(provider, id) : null;
          if (!targetModel) {
            console.warn(`[pi-agent] compact model "${modelId}" not found, using default`);
          } else if (!modelRuntime.hasConfiguredAuth(targetModel.provider)) {
            console.warn(`[pi-agent] no auth for compact model "${modelId}", using default`);
          } else if (!fitsModel(entry.session, targetModel)) {
            console.warn(`[pi-agent] conversation is larger than compact model "${modelId}" can take, using the conversation model`);
          } else {
            currentModel = agentState.model;
            agentState.model = targetModel;
            modelSwapped = true;
            console.log(`[pi-agent] compact using model (in-memory): ${modelId}`);
          }
        }

        if (agentState.thinkingLevel && agentState.thinkingLevel !== "off") {
          currentThinkingLevel = agentState.thinkingLevel;
          agentState.thinkingLevel = "off";
          thinkingSwapped = true;
          console.log(`[pi-agent] compact forcing thinkingLevel=off (was ${currentThinkingLevel})`);
        }
      }

      try {
        const result = await entry.session.compact();
        const usage = entry.session.getContextUsage();
        return {
          tokensBefore: result.tokensBefore,
          // pi reports no live count until the next response; its own estimate fills the gap.
          tokensAfter: usage?.tokens ?? result.estimatedTokensAfter ?? null,
        };
      } finally {
        if (modelSwapped) agentState.model = currentModel;
        if (thinkingSwapped) agentState.thinkingLevel = currentThinkingLevel;
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
      return enqueue(threadId, () => doPrompt(threadId, message));
    },

    async promptWithModel(threadId: string, message: AgentMessage, modelId: string): Promise<AgentResponse> {
      return enqueue(threadId, async () => {
        const entry = await getOrCreate(threadId);
        const currentModel = entry.session.model;

        // Resolve the target model (format: "provider/model-id")
        const modelRuntime = await getModelRuntime();
        let targetModel;
        const [provider, ...rest] = modelId.split("/");
        const id = rest.join("/");
        if (provider && id) {
          targetModel = modelRuntime.getModel(provider, id);
        }

        if (!targetModel) {
          console.warn(`[pi-agent] flush model "${modelId}" not found, using default`);
          return doPrompt(threadId, message);
        }

        // Verify auth is available for the target model
        if (!modelRuntime.hasConfiguredAuth(targetModel.provider)) {
          console.warn(`[pi-agent] no auth for flush model "${modelId}", using default`);
          return doPrompt(threadId, message);
        }

        if (!fitsModel(entry.session, targetModel)) {
          console.warn(`[pi-agent] conversation is larger than flush model "${modelId}" can take, using the conversation model`);
          return doPrompt(threadId, message);
        }

        // Swap model in-memory only (no persistence to settings.json or session log).
        // This avoids a crash-window where settings could be left on the flush model.
        const agentState = (entry.session as any).agent?.state;
        if (!agentState) {
          console.warn(`[pi-agent] cannot access agent state for model swap, using default`);
          return doPrompt(threadId, message);
        }

        agentState.model = targetModel;
        console.log(`[pi-agent] switched to flush model (in-memory): ${modelId}`);

        try {
          return await doPrompt(threadId, message);
        } finally {
          // Restore original model (in-memory only) — even if undefined
          agentState.model = currentModel;
        }
      });
    },

    promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
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
            // Images first: the manifest says which files went in as images.
            const images = await loadImages(message);
            const text = formatMessage(message);

            // "draining" / "drain_complete" tell the gateway that the agent is
            // still working after its first answer. Both sources below (events
            // inside prompt(), and a run found after prompt() resolved) go
            // through these so the user gets one notice, not two.
            let runEnded = false;
            let draining = false;
            // Provider error of the latest assistant message, reported only
            // if the run settles without pi having recovered from it.
            let pendingError: string | null = null;
            // pi announced a retry, or a compaction after an overflow; the next
            // run is pi asking again, not follow-up work.
            let recovering = false;
            const reportPendingError = () => {
              if (pendingError === null) return;
              eventQueue.push({ type: "model_error", message: pendingError });
              pendingError = null;
              resolve?.();
            };
            const notifyDraining = () => {
              if (draining) return;
              draining = true;
              eventQueue.push({ type: "draining" });
              resolve?.();
            };
            const notifyDrainComplete = () => {
              if (!draining) return;
              draining = false;
              eventQueue.push({ type: "drain_complete" });
              resolve?.();
            };

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

              // Follow-up work inside one prompt() (pi >= 1.0 drains its own
              // queues, so prompt() no longer returns between runs): a new
              // low-level run starting after one already ended means an
              // extension queued more work, e.g. a code-review follow-up.
              // Retries are the same run from the user's point of view.
              if (event.type === "agent_end") {
                if (!event.willRetry) runEnded = true;
              } else if (event.type === "auto_retry_start") {
                // pi is retrying the failed request itself.
                pendingError = null;
                recovering = true;
              } else if (event.type === "compaction_start") {
                // After an overflow pi compacts and asks again. The error
                // stays held until that is known to have worked: a failed
                // summary ends the run with no new assistant message, and the
                // overflow is then all there is to report (and what starts
                // roundhouse's own recovery).
                if (event.reason === "overflow") recovering = true;
              } else if (event.type === "compaction_end") {
                if (event.reason === "overflow") {
                  if (event.willRetry && !event.errorMessage && !event.aborted) pendingError = null;
                  else recovering = false;
                }
              } else if (event.type === "agent_start") {
                if (recovering) {
                  // pi's own retry: the same answer continuing.
                  recovering = false;
                } else if (runEnded) {
                  // Follow-up work queued by an extension. If the run before
                  // it ended in an error, that error belongs to the owner's
                  // request: report it now, or the follow-up's success would
                  // bury it.
                  reportPendingError();
                  notifyDraining();
                }
              } else if (event.type === "agent_settled") {
                runEnded = false;
                recovering = false;
                // The run is over and pi did not recover from the error.
                reportPendingError();
                notifyDrainComplete();
              }

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
                  // Hold it until the run settles: pi retries transient errors
                  // and compacts on overflow by itself, and reporting each
                  // failed attempt would post an error the user never needs
                  // to act on (and start roundhouse's own recovery on top).
                  const msg = (event as any).message;
                  if (msg?.role === "assistant") {
                    pendingError = msg.stopReason === "error" && msg.errorMessage ? String(msg.errorMessage) : null;
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
                notifyDraining,
                notifyDrainComplete,
                {
                  unsubscribeOld: () => { try { unsub(); } catch { /* ignore */ } },
                  subscribe: (newSession) => { unsub = newSession.subscribe(handleEvent); },
                },
                images,
              );
            } finally {
              try { unsub(); } catch { /* ignore */ }
              // Safety net: an error still held here was never reported.
              reportPendingError();
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
      disposed = true;
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
        // The next prompt creates the session. Without the marker it would
        // reopen the transcript just closed (continueRecent picks the newest
        // file), and "/new" would continue the old conversation.
        const threadDir = join(sessionsDir, threadIdToDir(threadId));
        await mkdir(threadDir, { recursive: true });
        writeFileSync(join(threadDir, NEW_SESSION_MARKER), new Date().toISOString() + "\n", { mode: 0o600 });
      });
    },

    async compact(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
      return compactSession(threadId, undefined);
    },

    async compactWithModel(threadId: string, modelId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
      return compactSession(threadId, modelId);
    },

    /**
     * Soft-reset an overflowed session: trim the on-disk jsonl to its most
     * recent N user turns, then reload the session in place. Used by the
     * memory-lifecycle layer when compact fails with "prompt is too long"
     * — the session has grown past the model's context window and the
     * summarizer prompt itself can no longer fit.
     *
     * Returns the soft-reset report (or null if no session for threadId).
     * Behavior:
     *   - In-memory session: returns null (nothing to trim on disk).
     *   - Already-trimmed session: report.reset === false, no reload.
     *   - Otherwise: trims file, reloads session, returns report.
     *
     * On reload failure, the SessionEntry is dropped from the cache so the
     * next prompt() recreates it cleanly.
     */
    async softReset(threadId: string): Promise<SoftResetReport | null> {
      return enqueue(threadId, async () => {
        const entry = sessions.get(threadId);
        if (!entry) return null;
        const sessionFile = entry.session.sessionFile;
        if (!sessionFile) {
          console.warn(`[pi-agent] softReset: ${threadId} has no on-disk session file, skipping`);
          return null;
        }

        console.warn(`[pi-agent] softReset: trimming overflowed session ${sessionFile}`);
        const report = softResetSessionFile(sessionFile);
        if (!report.reset) {
          console.log(`[pi-agent] softReset: nothing to trim (${report.reason})`);
          return report;
        }
        console.warn(
          `[pi-agent] softReset: ${report.entriesBefore} → ${report.entriesAfter} entries, ` +
          `${report.bytesBefore} → ${report.bytesAfter} bytes (${report.reason}). Backup: ${report.backupPath}`
        );

        // Reload the session so pi-ai re-reads the trimmed file. Drop the
        // cache entry on failure so the next prompt() recreates from scratch
        // rather than running against the disposed session.
        try {
          const reloaded = await reloadSession(entry, sessionFile);
          await entry.session.dispose();
          entry.session = reloaded.session;
        } catch (err) {
          console.error(`[pi-agent] softReset reload failed for ${threadId}:`, (err as Error).message);
          sessions.delete(threadId);
        }
        return report;
      });
    },

    /**
     * Switch this thread's conversation to another model. pi restores a
     * session's model from its transcript, so changing the default in pi's
     * settings alone never reaches a conversation that already exists.
     */
    async setModel(threadId: string, modelRef: string): Promise<{ applied: boolean; deferred?: boolean; detail?: string }> {
      const slash = modelRef.indexOf("/");
      const model = slash > 0
        ? (await getModelRuntime()).getModel(modelRef.slice(0, slash), modelRef.slice(slash + 1))
        : undefined;
      if (!model) return { applied: false, detail: `pi does not know the model ${modelRef}` };

      const apply = () => enqueue(threadId, async () => {
        const entry = await getOrCreate(threadId);
        if (!fitsModel(entry.session, model)) {
          const used = entry.session.getContextUsage()?.tokens ?? 0;
          return { applied: false, detail: `this conversation (${Math.round(used / 1000)}K tokens) does not fit its ${Math.round((model.contextWindow ?? 0) / 1000)}K window; /compact or /new first` };
        }
        try {
          await entry.session.setModel(model);
        } catch (err) {
          return { applied: false, detail: (err as Error).message };
        }
        console.log(`[pi-agent] ${threadId} switched to ${modelRef}`);
        return { applied: true };
      });

      // A turn is running: answer now, switch when it ends.
      if ((sessions.get(threadId)?.inFlight ?? 0) > 0) {
        void apply().then((r) => { if (!r.applied) console.warn(`[pi-agent] deferred model switch for ${threadId} failed: ${r.detail}`); })
          .catch((err) => console.warn(`[pi-agent] deferred model switch for ${threadId} failed:`, (err as Error).message));
        return { applied: true, deferred: true };
      }
      return apply();
    },

    /** Read (no level) or set the thinking level of this thread's conversation. */
    async thinkingLevel(threadId: string, level?: string): Promise<{ level: string; available: string[] } | null> {
      return enqueue(threadId, async () => {
        const entry = await getOrCreate(threadId);
        const available = entry.session.getAvailableThinkingLevels().map(String);
        if (level !== undefined) {
          if (!available.includes(level)) return { level: String(entry.session.thinkingLevel), available };
          entry.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
        }
        return { level: String(entry.session.thinkingLevel), available };
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

      let sessionStats: { cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } } | undefined;
      let thinking: string | undefined;
      if (threadEntry) {
        const model = threadEntry.session.model;
        if (model) modelInfo = `${model.provider}/${model.id}`;
        contextUsage = threadEntry.session.getContextUsage() ?? undefined;
        hasActiveSession = true;
        try {
          const stats = threadEntry.session.getSessionStats();
          sessionStats = { cost: stats.cost, tokens: stats.tokens };
          thinking = String(threadEntry.session.thinkingLevel);
        } catch { /* not worth failing /status for */ }
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
        ...(thinking ? { thinkingLevel: thinking } : {}),
        ...(sessionStats ? { sessionCost: sessionStats.cost, sessionTokens: sessionStats.tokens } : {}),
        hasMemoryExtension: memoryCapabilities?.hasMemoryExtension ?? null,
        memoryTools: memoryCapabilities?.memoryTools ?? [],
        extensions: memoryCapabilities?.extensions ?? [],
        ...(standingContext ? { standingContext: "system-prompt" as const } : {}),
      };
    },

    prepareMessage(_threadId: string, message: AgentMessage, _context: MessageContext): AgentMessage {
      return message;
    },
  };

  async function doPrompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    const entry = await getOrCreate(threadId);
    entry.lastUsed = Date.now();
    // Images first: the manifest says which files went in as images.
    const images = await loadImages(message);
    const text = formatMessage(message);

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
      }, images);
    } finally {
      try { unsub(); } catch { /* ignore */ }
    }

    return { text: fullText };
  }

  return adapter;
};

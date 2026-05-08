/**
 * gateway.ts — Roundhouse gateway
 *
 * Owns the Vercel Chat SDK instance and wires all platform events
 * through the agent router.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { AgentAdapter, AgentMessage, AgentRouter, AgentStreamEvent, GatewayConfig } from "./types";
import { splitMessage, isAllowed, startTypingLoop } from "./util";
import { isTelegramThread, postTelegramHtml } from "./telegram-html";
import { SttService, enrichAttachmentsWithTranscripts, DEFAULT_STT_CONFIG } from "./voice/stt-service";
import { sendTelegramToMany } from "./notify/telegram";
import { runDoctor, formatDoctorTelegram, createDoctorContext } from "./cli/doctor/runner";
import { ROUNDHOUSE_DIR, ROUNDHOUSE_VERSION } from "./config";
import { CronSchedulerService } from "./cron/scheduler";
import { isBuiltinJob } from "./cron/helpers";
import { formatSchedule, formatRunCounts, jobEnabledIcon } from "./cron/format";
import { BOT_COMMANDS } from "./commands";
import { prepareMemoryForTurn, finalizeMemoryForTurn, flushMemoryThenCompact, determineMemoryMode } from "./memory/lifecycle";
import { maxPressure } from "./memory/policy";
import type { PressureLevel, CompactResult } from "./memory/types";
import { readPendingPairing, completePendingPairing, isStartForNonce } from "./pairing";
import { createProgressMessage } from "./telegram-progress";
import { isCommand as _isCmd, isCommandWithArgs as _isCmdArgs, resolveAgentThreadId as _resolveThread, getSystemResources as _getSysRes, toolIcon as _toolIcon } from "./gateway/helpers";
import { saveAttachments as _saveAttachments, type AttachmentResult } from "./gateway/attachments";
import { handleStreaming as _handleStream, type StreamResult } from "./gateway/streaming";
import { handleNew, handleRestart, handleUpdate, handleCompact, handleStatus, type CommandContext } from "./gateway/commands";

/** Match a Telegram command, handling optional @botname suffix */
/** Bot username for command suffix validation (set during gateway init) */
let _botUsername = "";

function isCommand(text: string, cmd: string): boolean {
  return _isCmd(text, cmd, _botUsername);
}

/** Match a command that accepts subcommands (e.g. /crons trigger <id>) */
function isCommandWithArgs(text: string, cmd: string): boolean {
  return _isCmdArgs(text, cmd, _botUsername);
}
import { hostname } from "node:os";

function getSystemResources() {
  return _getSysRes();
}
import { join } from "node:path";


function resolveAgentThreadId(thread: any, message: any): string {
  return _resolveThread(thread, message);
}

// ── Chat SDK adapter factories ───────────────────────
// Lazy-imported so we don't crash if an adapter package isn't installed.

async function buildChatAdapters(
  config: GatewayConfig["chat"]["adapters"]
): Promise<Record<string, unknown>> {
  const adapters: Record<string, unknown> = {};

  if (config.telegram) {
    const { createTelegramAdapter } = await import("@chat-adapter/telegram");
    adapters.telegram = createTelegramAdapter({
      mode: (config.telegram.mode as "auto" | "polling" | "webhook") ?? "auto",
    });
  }

  return adapters;
}

function toolIcon(name: string): string {
  return _toolIcon(name);
}


async function saveAttachments(threadId: string, attachments: any[]): Promise<AttachmentResult> {
  return _saveAttachments(threadId, attachments);
}

// ── Gateway ──────────────────────────────────────────

export class Gateway {
  private chat!: Chat;
  private router: AgentRouter;
  private config: GatewayConfig;
  private pairingComplete = false;
  private sttService: SttService | null = null;
  private cronScheduler: CronSchedulerService | null = null;

  constructor(router: AgentRouter, config: GatewayConfig) {
    this.router = router;
    this.config = config;
    _botUsername = config.chat.botUsername || "";
  }

  /** Handle pending Telegram pairing from headless setup. Returns true if handled. */
  private async handlePendingPairing(
    text: string,
    message: any,
    thread: any,
    authorName: string,
  ): Promise<boolean> {
    try {
      const pending = await readPendingPairing();
      if (!pending || pending.status !== "pending" || !isStartForNonce(text, pending.nonce)) {
        return false;
      }

      const fromUser = authorName.toLowerCase();
      const allowed = pending.allowedUsers.map(u => u.toLowerCase());
      if (!fromUser || !allowed.includes(fromUser)) {
        console.log(`[roundhouse] Pairing nonce from unauthorized user @${authorName}`);
        return false;
      }

      // Extract IDs from the chat adapter message
      const chatId = typeof message.chatId === "number"
        ? message.chatId
        : typeof thread.id === "string" && thread.id.startsWith("telegram:")
          ? parseInt(thread.id.split(":")[1], 10)
          : undefined;
      // Chat SDK Telegram adapter provides userId (not id)
      const rawUserId = message.author?.userId ?? message.author?.id ?? message.raw?.from?.id;
      const userId = typeof rawUserId === "number"
        ? rawUserId
        : typeof rawUserId === "string"
          ? parseInt(rawUserId, 10)
          : undefined;

      if (chatId == null || Number.isNaN(chatId) || userId == null || Number.isNaN(userId)) {
        console.error(`[roundhouse] Pairing nonce matched but could not extract IDs: chatId=${chatId} userId=${userId}. Pairing left pending.`);
        await thread.post("⚠️ Pairing nonce accepted but could not capture your Telegram IDs. Try sending /start again, or run: roundhouse pair");
        return true;
      }

      await completePendingPairing({ chatId, userId, username: authorName });

      // Update in-memory config
      if (!this.config.chat.allowedUserIds) this.config.chat.allowedUserIds = [];
      if (!this.config.chat.allowedUserIds.includes(userId)) {
        this.config.chat.allowedUserIds.push(userId);
      }
      if (!this.config.chat.notifyChatIds) this.config.chat.notifyChatIds = [];
      if (!this.config.chat.notifyChatIds.includes(chatId)) {
        this.config.chat.notifyChatIds.push(chatId);
      }

      // Atomic config file update
      try {
        const { readFile: rf, rename: mvf, writeFile: wf, unlink: ulf } = await import("node:fs/promises");
        const { randomBytes: rb } = await import("node:crypto");
        const cfgPath = join(ROUNDHOUSE_DIR, "gateway.config.json");
        const configRaw = JSON.parse(await rf(cfgPath, "utf8"));
        if (!configRaw.chat) configRaw.chat = {};
        if (!configRaw.chat.allowedUserIds) configRaw.chat.allowedUserIds = [];
        if (!configRaw.chat.allowedUserIds.includes(userId)) configRaw.chat.allowedUserIds.push(userId);
        if (!configRaw.chat.notifyChatIds) configRaw.chat.notifyChatIds = [];
        if (!configRaw.chat.notifyChatIds.includes(chatId)) configRaw.chat.notifyChatIds.push(chatId);
        const tmp = `${cfgPath}.tmp.${rb(4).toString("hex")}`;
        await wf(tmp, JSON.stringify(configRaw, null, 2) + "\n");
        await mvf(tmp, cfgPath).catch(async (e) => { try { await ulf(tmp); } catch {} throw e; });
      } catch (cfgErr) {
        console.error("[roundhouse] failed to update config after pairing:", cfgErr);
      }

      console.log(`[roundhouse] Telegram pairing complete: @${authorName} chatId=${chatId} userId=${userId}`);
      this.pairingComplete = true;
      await thread.post("✅ Roundhouse paired successfully!\n\nSend /status to verify everything is working.");
      return true;
    } catch (err) {
      console.error("[roundhouse] error checking pending pairing:", err);
      return false;
    }
  }

  async start() {
    const chatAdapters = await buildChatAdapters(this.config.chat.adapters);

    // Initialize STT service (enabled by default, can be disabled via config)
    const rawSttConfig = this.config.voice?.stt;
    // Deep merge with defaults to handle partial configs
    const defaultProviders = DEFAULT_STT_CONFIG.providers;
    const mergedProviders: Record<string, any> = {};
    for (const key of new Set([...Object.keys(defaultProviders), ...Object.keys(rawSttConfig?.providers ?? {})])) {
      mergedProviders[key] = { ...defaultProviders[key], ...(rawSttConfig?.providers ?? {})[key] };
    }
    const sttConfig = {
      ...DEFAULT_STT_CONFIG,
      ...rawSttConfig,
      autoTranscribe: { ...DEFAULT_STT_CONFIG.autoTranscribe, ...rawSttConfig?.autoTranscribe },
      providers: mergedProviders,
    };
    if (sttConfig.enabled && sttConfig.mode !== "off") {
      this.sttService = new SttService(sttConfig);
      console.log(`[roundhouse] STT enabled (chain: ${sttConfig.chain.join(" -> ")}, autoInstall: ${sttConfig.autoInstall ?? false})`);
      // Prepare providers in background (install + warm model if needed)
      void this.sttService.prepareInBackground();
    }

    if (Object.keys(chatAdapters).length === 0) {
      throw new Error("No chat adapters configured. Add at least one in config.chat.adapters.");
    }

    this.chat = new Chat({
      userName: this.config.chat.botUsername,
      adapters: chatAdapters as any,
      state: createMemoryState(),
      concurrency: "concurrent",
    });

    const allowedUsers = (this.config.chat.allowedUsers ?? []).map((u) =>
      u.toLowerCase()
    );
    // Ensure arrays exist on config so pairing hook mutations are visible to isAllowed
    if (!this.config.chat.allowedUserIds) this.config.chat.allowedUserIds = [];
    if (!this.config.chat.notifyChatIds) this.config.chat.notifyChatIds = [];
    const allowedUserIds = this.config.chat.allowedUserIds;

    // SECURITY: Warn (loudly) when no auth allowlist is configured
    if (allowedUsers.length === 0 && allowedUserIds.length === 0) {
      console.warn("\n⚠️  WARNING: No allowedUsers or allowedUserIds configured!");
      console.warn("   Any Telegram user who finds this bot can interact with the agent.");
      console.warn("   Run: roundhouse setup --telegram --user <your-username>\n");
    }

    // Per-thread verbose toggle (shows tool_start messages)
    const verboseThreads = new Set<string>();

    // Per-thread abort signal for /stop
    const abortControllers = new Map<string, AbortController>();

    // Per-thread lock to serialize prompts (concurrent mode lets /stop through)
    const threadLocks = new Map<string, Promise<void>>();

    // ── Unified handler ────────────────────────────
    const handle = async (thread: any, message: any) => {
      const agentThreadId = resolveAgentThreadId(thread, message);
      const userText = message.text ?? "";
      const authorName = message.author?.userName ?? message.author?.userId ?? "?";
      const rawAttachments = message.attachments ?? [];

      console.log(
        `[roundhouse] ${thread.id} -> ${agentThreadId} @${authorName}: "${userText.slice(0, 120)}"${rawAttachments.length ? ` +${rawAttachments.length} attachment(s)` : ""}`
      );

      // Check for pending Telegram pairing (headless setup)
      if (userText.trim().startsWith("/start ") && !this.pairingComplete) {
        const handled = await this.handlePendingPairing(userText.trim(), message, thread, authorName ?? "");
        if (handled) return;
      }

      if (!isAllowed(message, allowedUsers, allowedUserIds)) {
        console.log(`[roundhouse] blocked @${authorName} (not in allowlist)`);
        return;
      }

      if (isCommand(userText, "/start")) return;
      if (!userText.trim() && !rawAttachments.length) return;

      // Handle /new command
      if (isCommand(userText.trim(), "/new")) {
        await handleNew(this.buildCommandContext(thread, message, agentThreadId, authorName, allowedUsers, allowedUserIds, verboseThreads, threadLocks));
        return;
      }

      // Handle /restart command
      if (isCommand(userText.trim(), "/restart")) {
        await handleRestart(this.buildCommandContext(thread, message, agentThreadId, authorName, allowedUsers, allowedUserIds, verboseThreads, threadLocks));
        return;
      }

      // Handle /update command
      if (isCommand(userText.trim(), "/update")) {
        await handleUpdate(this.buildCommandContext(thread, message, agentThreadId, authorName, allowedUsers, allowedUserIds, verboseThreads, threadLocks));
        return;
      }

      // Handle /compact command
      if (isCommand(userText.trim(), "/compact")) {
        await handleCompact(this.buildCommandContext(thread, message, agentThreadId, authorName, allowedUsers, allowedUserIds, verboseThreads, threadLocks));
        return;
      }

      // Handle /status command
      if (isCommand(userText.trim(), "/status")) {
        await handleStatus(this.buildCommandContext(thread, message, agentThreadId, authorName, allowedUsers, allowedUserIds, verboseThreads, threadLocks));
        return;
      }

      // Save any attachments (voice messages, images, files, etc.)
      let attachmentResult: AttachmentResult = { saved: [], skipped: [] };
      try {
        attachmentResult = await saveAttachments(agentThreadId, rawAttachments);
      } catch (err) {
        console.error(`[roundhouse] saveAttachments error:`, (err as Error).message);
        if (!userText.trim()) {
          try { await thread.post("⚠️ Failed to process attachment(s). Please try again."); } catch {}
          return;
        }
      }

      // Notify user about skipped attachments
      if (attachmentResult.skipped.length > 0) {
        const skipMsg = attachmentResult.skipped.map((s) => `\u2022 ${s}`).join("\n");
        try { await thread.post(`⚠️ Some attachments were skipped:\n${skipMsg}`); } catch {}
      }

      // Build AgentMessage
      const promptText = userText.trim();
      let agentMessage: AgentMessage = {
        text: promptText,
        attachments: attachmentResult.saved.length > 0 ? attachmentResult.saved : undefined,
      };

      if (!promptText && !agentMessage.attachments) {
        if (rawAttachments.length > 0) {
          // All attachments failed to save but message was attachment-only
          try { await thread.post("⚠️ Failed to save attachment(s). Please try again."); } catch {}
        }
        return;
      }

      const agent = this.router.resolve(agentThreadId);

      // Serialize prompts per-thread (concurrent mode allows /stop to bypass)
      const prevLock = threadLocks.get(agentThreadId);
      let releaseLock: () => void;
      const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
      threadLocks.set(agentThreadId, lockPromise);
      if (prevLock) await prevLock;

      console.log(`[roundhouse] → ${agent.name} | thread=${agentThreadId}`);

      // Enrich audio attachments with transcripts (STT) — inside thread lock to prevent stampede
      if (this.sttService && agentMessage.attachments?.length) {
        try {
          await enrichAttachmentsWithTranscripts(agentMessage.attachments, this.sttService, (text) => thread.post(text));
          // Update text for voice-only messages after transcription
          if (!agentMessage.text) {
            const transcripts = agentMessage.attachments
              .filter((a) => a.transcript?.status === "completed" && a.transcript.text)
              .map((a) => a.transcript!.text);
            if (transcripts.length > 0) {
              agentMessage.text = `Voice message transcript: ${transcripts.join(" ")}`;
            } else if (agentMessage.attachments.some((a) => a.mediaType === "audio")) {
              agentMessage.text = "Voice message attached, but automatic transcription failed.";
            }
          }
        } catch (err) {
          console.error(`[roundhouse] STT enrichment error:`, (err as Error).message);
        }
      }

      // ── Memory: pre-turn injection (Full mode only) ───
      const agentCwd = (agent.getInfo?.()?.cwd as string) ?? process.cwd();
      const memoryRoot = this.config.memory?.rootDir ?? agentCwd;
      let memoryPrepared: Awaited<ReturnType<typeof prepareMemoryForTurn>> | undefined;
      try {
        memoryPrepared = await prepareMemoryForTurn(agentThreadId, agentMessage, agent, memoryRoot, this.config.memory);
        agentMessage = memoryPrepared.message;
      } catch (err) {
        console.error(`[roundhouse] memory prepare error:`, (err as Error).message);
      }

      const stopTyping = startTypingLoop(thread);

      try {
        let turnUsedTools = false;
        if (agent.promptStream) {
          const ac = new AbortController();
          abortControllers.set(agentThreadId, ac);
          try {
            const streamResult = await this.handleStreaming(thread, agent.promptStream(agentThreadId, agentMessage), verboseThreads.has(agentThreadId), ac.signal);
            turnUsedTools = streamResult.usedTools;
          } finally {
            abortControllers.delete(agentThreadId);
          }
        } else {
          // Fallback: non-streaming prompt (assume tools may have been used)
          const reply = await agent.prompt(agentThreadId, agentMessage);
          turnUsedTools = true;
          if (reply.text) {
            await this.postWithFallback(thread, reply.text);
          }
        }

        // ── Memory: post-turn finalize + pressure check ───
        try {
          if (memoryPrepared) memoryPrepared.turnUsedTools = turnUsedTools;
          const pressure = await finalizeMemoryForTurn(
            agentThreadId,
            memoryPrepared ?? { message: agentMessage, beforeDigest: null, injected: false },
            agent, memoryRoot, this.config.memory,
          );
          // Use higher severity between pending compact and current pressure
          const effectivePressure = maxPressure(memoryPrepared?.pendingCompact, pressure);
          if (effectivePressure !== "none") {
            // Run flush/compact INSIDE the thread lock to prevent race with next user message
            try {
              await this.handleContextPressure(thread, agentThreadId, agent, memoryRoot, effectivePressure);
            } catch (err) {
              console.error(`[roundhouse] context pressure handler error:`, (err as Error).message);
            }
          }
        } catch (err) {
          console.error(`[roundhouse] memory finalize error:`, (err as Error).message);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = errMsg.split('\n')[0].slice(0, 200);
        console.error(`[roundhouse] agent error:`, err);
        try {
          await thread.post(`⚠️ Error: ${safeMsg}`);
        } catch {}
      } finally {
        stopTyping();
        releaseLock!();
        if (threadLocks.get(agentThreadId) === lockPromise) {
          threadLocks.delete(agentThreadId);
        }
      }
    };

    // ── Wire Chat SDK events ───────────────────────
    const handleOrAbort = async (thread: any, message: any) => {
      const agentThreadId = resolveAgentThreadId(thread, message);
      const text = (message.text ?? "").trim();
      // /stop is handled immediately — abort the in-flight agent run
      // without waiting for the current handler to finish
      if (isCommand(text, "/stop")) {
        if (!isAllowed(message, allowedUsers, allowedUserIds)) return;
        const agent = this.router.resolve(agentThreadId);
        if (agent.abort) {
          await agent.abort(agentThreadId);
          abortControllers.get(agentThreadId)?.abort();
          try { await thread.post("⏹️ Stopped."); } catch {}
        } else {
          try { await thread.post("⚠️ Abort not supported for this agent."); } catch {}
        }
        console.log(`[roundhouse] /stop for thread=${thread.id} agentThread=${agentThreadId}`);
        return;
      }
      // /verbose is a gateway toggle — runs immediately, no queuing
      if (isCommand(text, "/verbose")) {
        if (!isAllowed(message, allowedUsers, allowedUserIds)) return;
        const threadId = agentThreadId;
        if (verboseThreads.has(threadId)) {
          verboseThreads.delete(threadId);
          try { await thread.post("🔇 Verbose mode OFF — tool status messages hidden."); } catch {}
        } else {
          verboseThreads.add(threadId);
          try { await thread.post("📢 Verbose mode ON — showing tool calls."); } catch {}
        }
        console.log(`[roundhouse] /verbose for thread=${thread.id} agentThread=${threadId} -> ${verboseThreads.has(threadId) ? "on" : "off"}`);
        return;
      }
      // /doctor runs health checks immediately — no agent access needed
      if (isCommand(text, "/doctor")) {
        if (!isAllowed(message, allowedUsers, allowedUserIds)) return;
        const stopTyping = startTypingLoop(thread);
        try {
          const results = await runDoctor(await createDoctorContext());
          const report = formatDoctorTelegram(results);
          await this.postWithFallback(thread, report);
        } catch (err) {
          try { await thread.post(`⚠️ Doctor failed: ${(err as Error).message}`); } catch {}
        } finally {
          stopTyping();
        }
        console.log(`[roundhouse] /doctor for thread=${thread.id}`);
        return;
      }
      // /crons manages scheduled jobs
      if (isCommandWithArgs(text, "/crons") || isCommandWithArgs(text, "/jobs")) {
        if (!isAllowed(message, allowedUsers, allowedUserIds)) return;
        const stopTyping = startTypingLoop(thread);
        try {
          const parts = text.split(/\s+/).slice(1); // remove /crons
          const sub = parts[0];
          const id = parts[1];

          if (!this.cronScheduler) {
            await thread.post("⚠️ Cron scheduler not running.");
          } else if (sub === "trigger" && id) {
            if (isBuiltinJob(id)) { await thread.post(`⚠️ ${id} is a built-in job and cannot be triggered manually.`); }
            else { await thread.post(`⏳ Triggering ${id}...`); await this.cronScheduler.trigger(id); await thread.post(`✅ ${id} queued.`); }
          } else if (sub === "pause" && id) {
            if (isBuiltinJob(id)) { await thread.post(`⚠️ ${id} is a built-in job and cannot be paused.`); }
            else { await this.cronScheduler.pauseJob(id); await thread.post(`⏸️ ${id} paused.`); }
          } else if (sub === "resume" && id) {
            if (isBuiltinJob(id)) { await thread.post(`⚠️ ${id} is a built-in job and cannot be resumed.`); }
            else { await this.cronScheduler.resumeJob(id); await thread.post(`▶️ ${id} resumed.`); }
          } else {
            // Default: list jobs
            const items = await this.cronScheduler.listJobs();
            if (items.length === 0) {
              await thread.post("No cron jobs configured.\n\nCreate one with:\n`roundhouse cron add <id> --prompt \"...\" --every 6h`");
            } else {
              const lines = ["🕓 *Scheduled Jobs*", ""];
              for (const { job, state } of items) {
                const icon = jobEnabledIcon(job.enabled);
                const sched = formatSchedule(job.schedule);
                lines.push(`${icon} *${job.id}*`);
                lines.push(`   📅 ${sched}`);
                if (job.description) lines.push(`   📝 ${job.description}`);
                if (state.totalRuns > 0) {
                  lines.push(`   📊 ${formatRunCounts(state)}`);
                  if (state.lastFinishedAt) {
                    const ago = Math.round((Date.now() - new Date(state.lastFinishedAt).getTime()) / 60000);
                    const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
                    lines.push(`   ⏱ Last run: ${agoStr}`);
                  }
                } else {
                  lines.push(`   📊 No runs yet`);
                }
                lines.push("");
              }
              lines.push(`_${items.length} job(s) configured_`);
              await this.postWithFallback(thread, lines.join("\n"));
            }
          }
        } catch (err) {
          try { await thread.post(`⚠️ Cron error: ${(err as Error).message}`); } catch {}
        } finally {
          stopTyping();
        }
        console.log(`[roundhouse] /crons for thread=${thread.id}`);
        return;
      }
      await handle(thread, message);
    };

    this.chat.onDirectMessage(async (thread, message) => {
      await thread.subscribe();
      await handleOrAbort(thread, message);
    });

    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await handleOrAbort(thread, message);
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      await handleOrAbort(thread, message);
    });

    await this.chat.initialize();

    const platforms = Object.keys(this.config.chat.adapters).join(", ");
    console.log(`[roundhouse] gateway ready (platforms: ${platforms})`);

    // ── Register bot commands ───
    await this.registerBotCommands();

    // Start cron scheduler (await so job counts are available for startup notification)
    this.cronScheduler = new CronSchedulerService({
      agentConfig: this.config.agent,
      notifyChatIds: this.config.chat.notifyChatIds,
    });
    try {
      await this.cronScheduler.start();
    } catch (err) {
      console.error("[roundhouse] cron scheduler start failed:", (err as Error).message);
    }

    // Send startup notification (after cron init so we can include job counts)
    await this.notifyStartup(platforms);
  }

  /**
   * Handle context pressure — flush memory and/or compact.
   * Runs inside the thread lock after a turn completes.
   */
  private async handleContextPressure(thread: any, agentThreadId: string, agent: AgentAdapter, memoryRoot: string, pressure: PressureLevel) {
    if (pressure === "none") return;

    console.log(`[roundhouse] context pressure: ${pressure} for thread=${thread.id} agentThread=${agentThreadId}`);

    if (pressure === "soft") {
      // Soft: prompt agent to save facts, no compact
      // Cooldown is checked inside flushMemoryThenCompact (returns null if skipped)
      try {
        await flushMemoryThenCompact(agentThreadId, agent, memoryRoot, "soft", this.config.memory);
      } catch (err) {
        console.error(`[roundhouse] soft flush error:`, (err as Error).message);
      }
      return;
    }

    // Hard or emergency: flush + compact
    try {
      const prefix = pressure === "emergency" ? "⚠️ Context nearly full! " : "";
      const progress = await createProgressMessage(thread, `📝 ${prefix}Saving memory and compacting...`);
      const result = await flushMemoryThenCompact(
        agentThreadId, agent, memoryRoot, pressure, this.config.memory,
        (step) => progress.update(step),
      );
      if (result) {
        const beforeK = (result.tokensBefore / 1000).toFixed(1);
        const timing = result.timing;
        const timingLine = timing ? ` (${(timing.totalMs / 1000).toFixed(1)}s: flush ${(timing.flushMs / 1000).toFixed(1)}s + compact ${(timing.compactMs / 1000).toFixed(1)}s)` : "";
        await progress.update(`✅ Auto-compacted: ${beforeK}K tokens → summary.${timingLine}`);
      }
    } catch (err) {
      console.error(`[roundhouse] ${pressure} compact error:`, (err as Error).message);
    }
  }

  /**
   * Stream agent events to the chat thread.
   *
   * Strategy:
   * - Text deltas are collected per-turn and streamed via thread.handleStream()
   *   which does post+edit with rate limiting.
   * - Tool starts/ends are sent as compact status messages.
   * - Turn boundaries trigger a new message for the next turn's text.
   */

  private buildCommandContext(
    thread: any, message: any, agentThreadId: string, authorName: string,
    allowedUsers: string[], allowedUserIds: number[],
    verboseThreads: Set<string>, threadLocks: Map<string, Promise<void>>,
  ): CommandContext {
    return {
      thread,
      message,
      agentThreadId,
      authorName,
      agent: this.router.resolve(agentThreadId),
      config: this.config,
      allowedUsers,
      allowedUserIds,
      verboseThreads,
      threadLocks,
      postWithFallback: (t, text) => this.postWithFallback(t, text),
      stopGateway: () => this.stop(),
    };
  }

  private async handleStreaming(thread: any, stream: AsyncIterable<AgentStreamEvent>, verbose: boolean, signal?: AbortSignal): Promise<{ usedTools: boolean }> {
    return _handleStream(stream, {
      thread,
      verbose,
      signal,
      postWithFallback: (t, text) => this.postWithFallback(t, text),
    });
  }

  /** Post text with markdown, falling back to plain text */
  private async postWithFallback(thread: any, text: string) {
    // Telegram: send as HTML for proper markdown rendering
    if (isTelegramThread(thread)) {
      await postTelegramHtml(thread, text);
      return;
    }
    for (const chunk of splitMessage(text, 4000)) {
      try {
        await thread.post({ markdown: chunk });
      } catch {
        try {
          await thread.post(chunk);
        } catch (err) {
          console.error(`[roundhouse] post failed:`, (err as Error).message);
        }
      }
    }
  }

  /**
   * Register bot commands with Telegram so they appear in the / menu.
   * Runs on every startup to keep commands in sync with the code.
   */
  private async registerBotCommands() {
    if (!this.config.chat.adapters.telegram) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: BOT_COMMANDS }),
      });
      if (res.ok) {
        console.log(`[roundhouse] registered ${BOT_COMMANDS.length} bot commands with Telegram`);
      } else {
        const body = await res.text().catch(() => "");
        console.warn(`[roundhouse] failed to register bot commands (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[roundhouse] failed to register bot commands:`, (err as Error).message);
    }
  }

  /**
   * Send a startup notification to configured chat IDs.
   * Currently Telegram-only — when Slack/Discord adapters are added,
   * extend this to use their respective APIs or a Chat SDK broadcast API.
   */
  private async notifyStartup(platforms: string) {
    const chatIds = this.config.chat.notifyChatIds;
    if (!chatIds?.length) return;

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn("[roundhouse] notifyChatIds configured but TELEGRAM_BOT_TOKEN not set — skipping startup notification");
      return;
    }

    const bootTime = process.uptime();
    const host = hostname();
    const agentName = this.config.agent.type;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const nodeVer = process.version;
    const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);
    const sys = getSystemResources();

    // Get agent info if available (use first resolve — SingleAgentRouter always returns same agent)
    let agentInfo = "";
    try {
      const info = this.router.resolve("status").getInfo?.() ?? {};
      if (info.version) agentInfo += ` v${info.version}`;
      if (info.model) agentInfo += `\nModel: ${info.model}`;
    } catch {}

    // Cron info
    let cronInfo: string | null = null;
    if (this.cronScheduler) {
      const cs = this.cronScheduler.getStatus();
      cronInfo = `Cron jobs: ${cs.enabledCount}/${cs.jobCount} enabled`;
    }

    for (const chatId of chatIds) {
      const sessionId = Number(chatId) < 0 ? `group:${chatId}` : "main";
      const perChatText = [
        `\u2705 Roundhouse is online`,
        ``,
        `Session: ${sessionId}`,
        `Host: ${host}`,
        `Platforms: ${platforms}`,
        `Agent: ${agentName}${agentInfo}`,
        `Roundhouse: v${ROUNDHOUSE_VERSION}`,
        `Node: ${nodeVer}`,
        `Started: ${now}`,
        `Boot time: ${bootTime.toFixed(1)}s`,
        cronInfo,
        ``,
        `System:`,
        `  CPU: ${sys.cpuPct}% (load ${sys.load1.toFixed(2)}, ${sys.cpuCount} cores)`,
        `  RAM: ${sys.usedGB}/${sys.totalGB} GB (${sys.memPct}%)`,
        `  Process: ${memMB} MB RSS`,
      ].filter(line => line != null).join("\n");

      await sendTelegramToMany([chatId], perChatText);
    }
  }

  async stop() {
    if (this.cronScheduler) {
      try { await this.cronScheduler.stop(); } catch (e) { console.warn("[roundhouse] cron stop error:", e); }
    }
    try { await this.chat?.shutdown(); } catch (e) { console.warn("[roundhouse] chat shutdown error:", e); }
    await this.router.dispose();
    console.log("[roundhouse] stopped");
  }
}

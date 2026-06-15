/**
 * gateway.ts — Roundhouse gateway
 *
 * Owns the Vercel Chat SDK instance and wires all platform events
 * through the agent router.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { AgentAdapter, AgentMessage, AgentRouter, AgentStreamEvent, GatewayConfig } from "../types";
import { splitMessage, isAllowed, startTypingLoop, sameId } from "../util";
import { SttService, enrichAttachmentsWithTranscripts, DEFAULT_STT_CONFIG } from "../voice/stt-service";
import { runDoctor, formatDoctorTelegram, createDoctorContext } from "../cli/doctor/runner";
import { ROUNDHOUSE_DIR, ROUNDHOUSE_VERSION } from "../config";
import { CronSchedulerService } from "../cron/scheduler";
import { IpcServer, createIpcHandler } from "../ipc";
import { prepareMemoryForTurn, finalizeMemoryForTurn, flushMemoryThenCompact } from "../memory/lifecycle";
import { recoverFromAgentTurnOverflow, type TurnSource } from "./overflow";
import { maxPressure } from "../memory/policy";
import type { PressureLevel } from "../memory/types";
// progress messages now flow through the transport via this.transport.progress().
import { isCommand as _isCmd, isCommandWithArgs as _isCmdArgs, resolveAgentThreadId as _resolveThread, getSystemResources as _getSysRes } from "./helpers";
import { saveAttachments, type AttachmentResult } from "./attachments";
import { handleStreaming as _handleStream, StreamModelOverflowError } from "./streaming";
import { handleNew, handleRestart, handleUpdate, handleCompact, handleStatus, handleCancel, handleVerbose, handleDoctor, handleCrons, type CommandContext } from "./commands";
import { handleModel, handleModelAction, MODEL_ACTION_ID } from "./model-command";
import { handleLater } from "./later-command";
import { handleTopic, handleTopicAction, TOPIC_ACTION_ID, applyTopicOverride } from "./topic-command";
import {
  type CommandDescriptor,
  type CommandInvocation,
  type CommandResult,
  collectAndValidateActions,
  isPreTurn,
  matchesDescriptor,
} from "./command-registry";
import { TelegramAdapter, SlackAdapter, CompositeTransportAdapter, buildCompositeTransport, buildChatSdkAdapters } from "../transports";
import type { TransportAdapter } from "../transports";
import { SubAgentOrchestratorImpl, SubAgentWatcher } from "../subagents";
import type { RunStatus, RoutingInfo } from "../subagents";
import { BotUsernameResolver } from "./bot-username-resolver";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { injectToolsSection } from "./tools-inject";
import { injectPersonaSection, loadPersona } from "./persona-inject";
import { checkVersionChange } from "./whats-new";

/** Origin of an agent turn — used for recovery copy and telemetry. */
export type { TurnSource };

/** Limits */
const MAX_SUBAGENT_STDOUT_CHARS = 3000;
const MAX_MESSAGE_CHUNK = 4000;

/**
 * Build the list of `TransportAdapter` delegates from the configured
 * chat-adapter keys. The Slack delegate is loaded lazily because
 * @chat-adapter/slack may not be installed in older deployments —
 * if Slack is configured, it MUST be installed; we fail loudly there.
 */
function buildTransportDelegates(
  config: GatewayConfig["chat"]["adapters"],
): TransportAdapter[] {
  const delegates: TransportAdapter[] = [];
  if (config.telegram) delegates.push(new TelegramAdapter());
  if (config.slack) delegates.push(new SlackAdapter());
  // Caller (Gateway.start) validates `chatAdapters` is non-empty before
  // subscribing to events. We don't throw here on empty so test harnesses
  // that inject a fake transport after construction still work.
  return delegates;
}

// ── Matchers ──────────────────────────────────────────
// Build command matchers for a given botUsername.
// Shared by pre-turn and in-turn dispatch to avoid duplication.
function buildMatchers(botUsername: string) {
  return {
    isCommand: (t: string, c: string) => _isCmd(t, c, botUsername),
    isCommandWithArgs: (t: string, c: string) => _isCmdArgs(t, c, botUsername),
  };
}

// ── Gateway ──────────────────────────────────────────

export class Gateway {
  private chat!: Chat;
  private router: AgentRouter;
  private config: GatewayConfig;
  private transport: CompositeTransportAdapter;
  private botUsernameResolver: BotUsernameResolver;
  /**
   * Per-transport "pairing complete" flag. Keyed by transport delegate name.
   * Replaces a single boolean that would silently block a second transport's
   * pairing once the first one paired.
   */
  private pairingComplete = new Map<string, boolean>();
  private sttService: SttService | null = null;
  private cronScheduler: CronSchedulerService | null = null;
  private ipcServer: IpcServer | null = null;
  private subagentOrchestrator: SubAgentOrchestratorImpl | null = null;
  private subagentWatcher: SubAgentWatcher | null = null;
  private verboseThreads = new Set<string>();
  private threadLocks = new Map<string, Promise<void>>();
  private abortControllers = new Map<string, AbortController>();
  private flushInProgress = new Set<string>();

  constructor(router: AgentRouter, config: GatewayConfig) {
    this.router = router;
    this.config = config;
    // kiro-cli manages its own session context (large window + native /compact),
    // so roundhouse's memory layer (injection + summarize/flush/compact) is
    // redundant and fights kiro's own management — it can't actually shrink
    // kiro's context, so it loops a flush every turn once kiro passes the
    // percent threshold. Default memory OFF for kiro unless the operator
    // explicitly opted in via config.memory.enabled. Other agents (e.g. pi
    // without a memory extension) keep roundhouse-managed memory.
    if (this.config.agent?.type === "kiro" && this.config.memory?.enabled === undefined) {
      this.config.memory = { ...this.config.memory, enabled: false };
      console.log("[roundhouse] kiro self-manages context — roundhouse memory disabled (set memory.enabled=true to override)");
    }
    // Initialize bot username resolver with per-adapter overrides
    const adapterOverrides: Record<string, string> = {};
    for (const [adapterName, adapterConfig] of Object.entries(config.chat.adapters)) {
      if (adapterConfig && typeof adapterConfig === 'object' && 'botUsername' in adapterConfig) {
        const botUsername = (adapterConfig as any).botUsername;
        // Only accept string overrides; ignore non-strings to prevent crashes in helpers
        if (typeof botUsername === 'string' && botUsername.length > 0) {
          adapterOverrides[adapterName] = botUsername;
        }
      }
    }
    this.botUsernameResolver = new BotUsernameResolver({
      globalBotUsername: config.chat.botUsername || "",
      adapterOverrides,
    });
    const delegates = buildTransportDelegates(config.chat.adapters);
    // Empty config (e.g. test harnesses that override `transport` post-construction)
    // gets a single-delegate composite around a stub Telegram adapter so the
    // composite's "at least one delegate" invariant holds. Real deployments
    // always have at least one configured.
    this.transport = buildCompositeTransport(delegates.length > 0 ? delegates : [new TelegramAdapter()]);
    // BotUsernameResolver handles bot identity per transport; no global fallback needed
  }

  /** Handle pending pairing via transport adapter. Returns true if handled. */
  private async handlePendingPairing(
    message: any,
    thread: any,
  ): Promise<boolean> {
    try {
      const result = await this.transport.handlePairing(thread, message);
      if (!result) return false;

      // String IDs (Slack `Uxxx`/`Cxxx`) and numeric IDs (Telegram) coexist
      // in the widened config arrays. Persist as-is — JSON handles either.
      const { threadId, userId, username, transport: transportName } = result;

      if (threadId == null || userId == null) {
        console.error(`[roundhouse] Pairing returned null IDs: threadId=${threadId} userId=${userId}`);
        return false;
      }

      // Update in-memory config (heterogeneous union list)
      if (!this.config.chat.allowedUserIds) this.config.chat.allowedUserIds = [];
      if (!this.config.chat.allowedUserIds.some(id => sameId(id, userId))) {
        this.config.chat.allowedUserIds.push(userId);
      }
      if (!this.config.chat.notifyChatIds) this.config.chat.notifyChatIds = [];
      if (!this.config.chat.notifyChatIds.some(id => sameId(id, threadId))) {
        this.config.chat.notifyChatIds.push(threadId);
      }

      // Persist config atomically
      try {
        const { readFile: rf, rename: mvf, writeFile: wf, unlink: ulf } = await import("node:fs/promises");
        const { randomBytes: rb } = await import("node:crypto");
        const cfgPath = join(ROUNDHOUSE_DIR, "gateway.config.json");
        const configRaw = JSON.parse(await rf(cfgPath, "utf8"));
        if (!configRaw.chat) configRaw.chat = {};
        if (!configRaw.chat.allowedUserIds) configRaw.chat.allowedUserIds = [];
        if (!configRaw.chat.allowedUserIds.some((id: string | number) => sameId(id, userId))) {
          configRaw.chat.allowedUserIds.push(userId);
        }
        if (!configRaw.chat.notifyChatIds) configRaw.chat.notifyChatIds = [];
        if (!configRaw.chat.notifyChatIds.some((id: string | number) => sameId(id, threadId))) {
          configRaw.chat.notifyChatIds.push(threadId);
        }
        const tmp = `${cfgPath}.tmp.${rb(4).toString("hex")}`;
        await wf(tmp, JSON.stringify(configRaw, null, 2) + "\n");
        await mvf(tmp, cfgPath).catch(async (e) => { try { await ulf(tmp); } catch {} throw e; });
      } catch (cfgErr) {
        console.error("[roundhouse] failed to update config after pairing:", cfgErr);
      }

      console.log(`[roundhouse] Pairing complete (${transportName ?? "?"}): @${username} threadId=${threadId} userId=${userId}`);
      if (transportName) {
        this.pairingComplete.set(transportName, true);
      }
      await thread.post("✅ Roundhouse paired successfully!\n\nSend /status to verify everything is working.");
      return true;
    } catch (err) {
      console.error("[roundhouse] error checking pending pairing:", err);
      return false;
    }
  }

  async start() {
    const chatAdapters = await buildChatSdkAdapters(this.config.chat.adapters);

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
      console.log(`[roundhouse] STT enabled (chain: ${sttConfig.chain.join(" -> ")})`);
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
    // Ensure arrays exist on config so pairing hook mutations are visible to isAllowed.
    // Heterogeneous (string | number)[] — Telegram IDs are numeric, Slack are strings.
    if (!this.config.chat.allowedUserIds) this.config.chat.allowedUserIds = [];
    if (!this.config.chat.notifyChatIds) this.config.chat.notifyChatIds = [];
    const allowedUserIds: (string | number)[] = this.config.chat.allowedUserIds;

    // SECURITY: Warn (loudly) when no auth allowlist is configured
    if (allowedUsers.length === 0 && allowedUserIds.length === 0) {
      console.warn("\n⚠️  WARNING: No allowedUsers or allowedUserIds configured!");
      console.warn("   Any Telegram user who finds this bot can interact with the agent.");
      console.warn("   Run: roundhouse setup --telegram --user <your-username>\n");
    }

    // Per-thread verbose toggle (shows tool_start messages)
    const verboseThreads = this.verboseThreads;

    // Per-thread abort signal for /cancel
    const abortControllers = this.abortControllers;

    // Per-thread lock to serialize prompts (concurrent mode lets /cancel through)
    const threadLocks = this.threadLocks;

    // ── Build command descriptors ──────────────────────
    // Each descriptor self-describes its triggers, dispatch stage, and
    // optional inline-keyboard callbacks. The gateway iterates this list
    // to wire everything — no more per-command if-blocks or onAction calls.
    // Adding a new command = one more entry here + (optionally) a new module.
    const allDescriptors = this.buildCommandDescriptors({
      allowedUsers, allowedUserIds, verboseThreads, threadLocks, abortControllers,
    });
    const preTurnCommands = allDescriptors.filter(isPreTurn);
    const inTurnCommands = allDescriptors.filter(d => !isPreTurn(d));



    // ── Unified handler ──────────────────────────────
    const handle = async (thread: any, message: any) => {
      const agentThreadId = applyTopicOverride(_resolveThread(thread, message), thread);
      const userText = message.text ?? "";
      const authorName = message.author?.userName ?? message.author?.userId ?? "?";
      const rawAttachments = message.attachments ?? [];

      console.log(
        `[roundhouse] ${thread.id} -> ${agentThreadId} @${authorName}: "${userText.slice(0, 120)}"${rawAttachments.length ? ` +${rawAttachments.length} attachment(s)` : ""}`
      );

      // Check for pending pairing via the transport that owns this thread.
      // Per-transport `pairingComplete` flag prevents one paired transport
      // from short-circuiting another that's still pending.
      const owningTransport = this.transport.ownerOf(thread);
      const ownerName = owningTransport?.name;
      if (ownerName && !this.pairingComplete.get(ownerName) && await this.transport.isPairingPending()) {
        const handled = await this.handlePendingPairing(message, thread);
        if (handled) return;
      }

      if (!isAllowed(message, allowedUsers, allowedUserIds)) {
        console.log(`[roundhouse] blocked @${authorName} (not in allowlist)`);
        return;
      }

      // Transport-specific message filtering (e.g. Telegram /start <nonce> handshake).
      if (this.transport.shouldIgnoreMessage?.(userText, message, thread)) return;
      if (!userText.trim() && !rawAttachments.length) return;

      // ── Command dispatch (in-turn stage) ───
      const trimmed = userText.trim();
      // Resolve bot username for this thread's transport, then dispatch
      const botUsername = this.botUsernameResolver.resolve(thread);
      if (await this.dispatchInTurnCommand(inTurnCommands, thread, botUsername, message, trimmed, agentThreadId)) {
        return;
      }

      // Dispatch to agent turn handler
      await this.handleAgentTurn(thread, agentThreadId, userText, rawAttachments, verboseThreads, threadLocks, abortControllers);
    };

    // ── Wire Chat SDK events ───────────────────────
    const handleOrAbort = async (thread: any, message: any) => {
      const agentThreadId = applyTopicOverride(_resolveThread(thread, message), thread);
      const text = (message.text ?? "").trim();

      // Pre-turn commands fire before the main handler (and before the
      // session-pressure gate), so /cancel etc. still interrupt a mid-run
      // agent. Allowlist is enforced here for all pre-turn handlers.
      // Resolve bot username for this thread's transport for @botname matching
      const botUsername = this.botUsernameResolver.resolve(thread);
      const matchers = buildMatchers(botUsername);
      for (const desc of preTurnCommands) {
        if (matchesDescriptor(desc, text, matchers)) {
          if (!isAllowed(message, allowedUsers, allowedUserIds)) return;
          const result = await desc.invoke({ thread, message, text, agentThreadId });
          await this.postCommandResult(thread, result);
          return;
        }
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

    // ── Load persona files at startup (cached for process lifetime) ───
    loadPersona();

    // ── Handle inline keyboard callbacks ───
    // ── Register inline-keyboard action handlers from all descriptors ───
    // `collectAndValidateActions` throws if two descriptors claim the same
    // action id — duplicates would silently misbehave on chat.onAction, so
    // fail fast at startup.
    for (const { actionId, handler } of collectAndValidateActions(allDescriptors)) {
      this.chat.onAction(actionId, async (event: any) => {
        const result = await handler({ value: event.value, thread: event.thread });
        await this.postCommandResult(event.thread, result);
      });
    }

    await this.chat.initialize();

    // Slack-specific post-initialize wiring (no-op when slack isn't configured):
    //  1. Attach the Chat SDK Slack adapter instance to our SlackAdapter
    //     delegate so postRich/progress/stream can call its webClient.
    //     The SDK's own initialize() already called auth.test and populated
    //     botUserId, so the bot self-loop filter is armed by the time events
    //     start flowing — no extra eager call needed here (verified against
    //     @chat-adapter/slack@4.29.0 dist/index.js:868-885).
    //  2. Register onAssistantThreadStarted to drive first-DM pairing
    //     before the user has typed anything.
    const slackDelegate = this.transport.delegates.find((d): d is SlackAdapter => d.name === "slack") as SlackAdapter | undefined;
    if (slackDelegate) {
      try {
        const slackSdk = (this.chat as unknown as { getAdapter(name: string): unknown }).getAdapter("slack") as Parameters<SlackAdapter["attach"]>[0];
        if (slackSdk) {
          slackDelegate.attach(slackSdk);
          this.registerAssistantThreadStartedHandler();
        } else {
          console.warn("[roundhouse] slack adapter not exposed via chat.getAdapter('slack') — pairing/streaming may not work");
        }
      } catch (err) {
        console.error("[roundhouse] slack post-initialize wiring failed:", (err as Error).message);
      }
    }

    const platforms = Object.keys(this.config.chat.adapters).join(", ");
    console.log(`[roundhouse] gateway ready (platforms: ${platforms})`);

    // ── Register bot commands ───
    await this.registerBotCommands();

    // Start cron scheduler (await so job counts are available for startup notification)
    this.cronScheduler = new CronSchedulerService({
      agentConfig: this.config.agent,
      notifyChatIds: this.config.chat.notifyChatIds,
      notifyFn: async (chatIds: (string | number)[], text: string) => {
        if (chatIds.length && this.transport) {
          await this.transport.notify(chatIds, text);
        }
      },
    });
    try {
      await this.cronScheduler.start();
    } catch (err) {
      console.error("[roundhouse] cron scheduler start failed:", (err as Error).message);
    }

    // Start IPC server for CLI → gateway communication
    this.ipcServer = new IpcServer(createIpcHandler(this.transport, () => this.config));
    try {
      await this.ipcServer.start();
    } catch (err) {
      console.error("[roundhouse] IPC server start failed:", (err as Error).message);
    }

    // Start sub-agent orchestrator + watcher
    this.subagentOrchestrator = new SubAgentOrchestratorImpl();
    this.subagentOrchestrator.onSpawn(async (status) => {
      // Sub-agent routing carries the chatId as a string; preserve as-is so
      // both telegram (numeric-as-string) and slack (`Cxxx`) work. Composite
      // partitions by ownsChatId before fanning out.
      const chatId = status.routing?.chatId;
      if (chatId) {
        const msg = `🔬 **Sub-agent launched** (${status.role})\nrun: \`${status.runId.slice(0, 8)}\``;
        try { await this.transport.notify([chatId], msg); } catch {}
      }
    });
    this.subagentWatcher = new SubAgentWatcher(
      this.subagentOrchestrator,
      async (status, routing) => {
        await this.handleSubagentCompletion(status, routing);
      },
    );
    this.subagentWatcher.start();
    console.log("[roundhouse] sub-agent watcher started");

    // Send startup notification (after cron init so we can include job counts)
    await this.notifyStartup(platforms);

    // Fire boot turn — agent says hello (seeds session so it's never empty)
    await this.fireBootTurn(verboseThreads, threadLocks, abortControllers);
  }

  /**
   * Process a user message through the agent pipeline:
   * save attachments → build message → STT → memory inject → prompt → memory finalize → pressure check
   */
  private async handleAgentTurn(
    thread: any, agentThreadId: string, userText: string, rawAttachments: any[],
    verboseThreads: Set<string>, threadLocks: Map<string, Promise<void>>, abortControllers: Map<string, AbortController>,
    turnSource: TurnSource = "user",
  ): Promise<void> {
    // Prepare message (save attachments, build AgentMessage)
    const result = await this.prepareAgentMessage(thread, agentThreadId, userText, rawAttachments);
    if (!result) return; // nothing to send (empty message after attachment failure)
    let agentMessage = result;

    const agent = this.router.resolve(agentThreadId);

    // Serialize prompts per-thread (concurrent mode allows /cancel to bypass)
    const prevLock = threadLocks.get(agentThreadId);
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    threadLocks.set(agentThreadId, lockPromise);
    if (prevLock) await prevLock;

    let stopTyping: (() => void) | null = null;
    let deferredSoftFlush: { thread: any; agentThreadId: string; agent: AgentAdapter; memoryRoot: string } | undefined;
    try {
      console.log(`[roundhouse] → ${agent.name} | thread=${agentThreadId}`);

      // Enrich audio attachments with transcripts (STT) — show typing while processing
      if (agentMessage.attachments?.some((a: any) => a.mediaType === "audio")) {
        const sttTyping = startTypingLoop(thread);
        try {
          await this.enrichWithStt(thread, agentMessage);
        } finally {
          sttTyping();
        }
      } else {
        await this.enrichWithStt(thread, agentMessage);
      }

      // Inject tools section (after STT enrichment so voice-only messages get it too)
      if (agentMessage.text) {
        agentMessage.text = injectPersonaSection(agentMessage.text);
        agentMessage.text = injectToolsSection(agentMessage.text);
      }

      // Let the agent adapter apply platform-specific message transforms
      if (agent.prepareMessage) {
        try {
          agentMessage = agent.prepareMessage(agentThreadId, agentMessage, {
            platform: this.transport.name,
            hasAttachments: !!(agentMessage.attachments?.length),
          });
        } catch (err) {
          console.error(`[roundhouse] prepareMessage error:`, (err as Error).message);
        }
      }

      // Memory: pre-turn injection (Full mode only)
      const agentCwd = (agent.getInfo?.()?.cwd as string) ?? process.cwd();
      const memoryRoot = this.config.memory?.rootDir ?? agentCwd;
      let memoryPrepared: Awaited<ReturnType<typeof prepareMemoryForTurn>> | undefined;
      try {
        memoryPrepared = await prepareMemoryForTurn(agentThreadId, agentMessage, agent, memoryRoot, this.config.memory);
        agentMessage = memoryPrepared.message;
      } catch (err) {
        console.error(`[roundhouse] memory prepare error:`, (err as Error).message);
      }

      // Inject a Slack-specific stopTyping hook when the thread belongs
      // to Slack — the SDK's default clear path is broken in 4.29.0
      // (sends `loading_messages: [""]` which Slack rejects). For
      // non-Slack threads slackStopTyping is null and the typing loop
      // falls back to thread.startTyping("") (Telegram's sendChatAction
      // auto-expires anyway so the call is harmless there).
      //
      // Wrapper object delegates startTyping back to the original thread
      // so we keep its `this`-binding. Don't spread the class instance —
      // that would lose its prototype.
      const slackDelegate = this.transport.delegates.find((d) => d.name === "slack") as SlackAdapter | undefined;
      const slackStopTyping = slackDelegate?.stopTypingFor?.(thread) ?? null;
      const typingThread = slackStopTyping
        ? {
            startTyping: (status?: string) => thread.startTyping(status),
            stopTyping: slackStopTyping,
          }
        : thread;
      stopTyping = startTypingLoop(typingThread);

      // Pre-turn recovery: if a prior turn failed to compact (state has
      // pendingCompact === "emergency"), the live session is almost certainly
      // still over the model's context limit, so calling agent.prompt() now
      // will throw with "prompt is too long" before our post-turn pressure
      // handler ever runs — perpetuating the loop. Run the pressure handler
      // BEFORE the agent call to recover. Best-effort: if it fails, fall
      // through to the normal turn (which will then post the error and let
      // the user see something is wrong).
      if (memoryPrepared?.pendingCompact === "emergency") {
        console.log(`[roundhouse] pre-turn recovery: pendingCompact=emergency, compacting before agent.prompt for thread=${agentThreadId}`);
        try {
          await this.handleContextPressure(thread, agentThreadId, agent, memoryRoot, "emergency");
          // Clear the pending flag in our prepared snapshot so the post-turn
          // pressure logic doesn't double-up on a redundant emergency pass.
          memoryPrepared.pendingCompact = undefined;
        } catch (err) {
          console.error(`[roundhouse] pre-turn emergency compact failed:`, (err as Error).message);
        }
      }

      // Note: deferredSoftFlush is hoisted to the outer try-finally above
      // so the post-finally `if (deferredSoftFlush) { ... }` block (line ~530)
      // can still see it. Earlier versions declared it here, then read it
      // OUTSIDE the enclosing try block — a scoping bug that tsc surfaced.
      // streamHadVisibleText is hoisted for the same reason: the catch below
      // needs to know whether the user already saw partial assistant text
      // when picking gateway-overflow recovery copy.
      let streamHadVisibleText = false;
      try {
        let turnUsedTools = false;
        if (agent.promptStream) {
          const ac = new AbortController();
          abortControllers.set(agentThreadId, ac);
          try {
            const streamResult = await this.handleStreaming(thread, agent.promptStream(agentThreadId, agentMessage), verboseThreads.has(agentThreadId), ac.signal);
            turnUsedTools = streamResult.usedTools;
            streamHadVisibleText = streamResult.hadVisibleText;
          } finally {
            abortControllers.delete(agentThreadId);
          }
        } else {
          const reply = await agent.prompt(agentThreadId, agentMessage);
          turnUsedTools = true;
          if (reply.text) {
            await this.postWithFallback(thread, reply.text);
          }
        }

        // Memory: post-turn finalize + pressure check
        try {
          if (memoryPrepared) memoryPrepared.turnUsedTools = turnUsedTools;
          const pressure = await finalizeMemoryForTurn(
            agentThreadId,
            memoryPrepared ?? { message: agentMessage, beforeDigest: null, injected: false },
            agent, memoryRoot, this.config.memory,
          );
          const effectivePressure = maxPressure(memoryPrepared?.pendingCompact, pressure);
          if (effectivePressure === "soft") {
            // Soft flush deferred to OUTSIDE the lock (no memory state invariants affected)
            deferredSoftFlush = { thread, agentThreadId, agent, memoryRoot };
          } else if (effectivePressure !== "none") {
            // Hard/emergency: must run INSIDE the lock (compact changes session state,
            // prepareMemoryForTurn on next turn needs post-compact reinjection)
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
        // Extract hadVisibleText from StreamModelOverflowError if present
        const errorHadVisibleText = err instanceof StreamModelOverflowError ? err.hadVisibleText : streamHadVisibleText;
        await recoverFromAgentTurnOverflow(thread, agentThreadId, agent, err, {
          turnSource,
          hadVisibleText: errorHadVisibleText,
        });
      } finally {
        if (stopTyping) stopTyping();
      }
    } finally {
      releaseLock!();
      if (threadLocks.get(agentThreadId) === lockPromise) {
        threadLocks.delete(agentThreadId);
      }
    }

    // Soft flush runs OUTSIDE the thread lock.
    // Soft flush only prompts the agent to save facts to MEMORY.md — no compact,
    // no session state change, no force-reinject needed. Safe to run concurrently.
    if (deferredSoftFlush && !this.flushInProgress.has(deferredSoftFlush.agentThreadId)) {
      const { thread: t, agentThreadId: tid, agent: a, memoryRoot: mr } = deferredSoftFlush;
      this.flushInProgress.add(tid);
      console.log(`[roundhouse] soft flush for thread=${tid} (lock released, running async)`);
      try {
        await this.handleContextPressure(t, tid, a, mr, "soft");
      } catch (err) {
        console.error(`[roundhouse] soft flush error:`, (err as Error).message);
      } finally {
        this.flushInProgress.delete(tid);
      }
    }
  }

  /**
   * Enrich audio attachments with speech-to-text transcripts.
   * Updates agentMessage.text for voice-only messages.
   * If STT deps are missing, injects an install-prompt for the agent.
   */
  private async enrichWithStt(thread: any, agentMessage: AgentMessage): Promise<void> {
    if (!this.sttService || !agentMessage.attachments?.length) return;
    try {
      await enrichAttachmentsWithTranscripts(agentMessage.attachments, this.sttService, (text) => thread.post(text));

      // Check if any audio attachments failed transcription
      const hasFailedAudio = agentMessage.attachments.some(
        (a) => a.mediaType === "audio" && a.transcript?.status === "failed",
      );

      if (!agentMessage.text) {
        const transcripts = agentMessage.attachments
          .filter((a) => a.transcript?.status === "completed" && a.transcript.text)
          .map((a) => a.transcript!.text);
        if (transcripts.length > 0) {
          agentMessage.text = `Voice message transcript: ${transcripts.join(" ")}`;
        } else if (hasFailedAudio) {
          // STT failed — check if deps are missing and inject agent prompt
          const missing = await this.sttService.getMissingDeps();
          if (missing.length > 0) {
            await thread.post(`🎤 Voice transcription not available yet (missing: ${missing.join(", ")}). Asking agent to install...`);
            agentMessage.text = this.buildSttInstallPrompt(missing, agentMessage.attachments);
          } else {
            agentMessage.text = "Voice message attached, but automatic transcription failed.";
          }
        }
      } else if (hasFailedAudio) {
        // User sent text + audio, but audio transcription failed
        const missing = await this.sttService.getMissingDeps();
        if (missing.length > 0) {
          await thread.post(`🎤 Voice transcription not available yet (missing: ${missing.join(", ")}). Asking agent to install...`);
          agentMessage.text += "\n\n" + this.buildSttInstallPrompt(missing, agentMessage.attachments);
        } else {
          agentMessage.text += "\n\n(Note: a voice message was also attached but automatic transcription failed.)";
        }
      }
    } catch (err) {
      console.error(`[roundhouse] STT enrichment error:`, (err as Error).message);
    }
  }

  /**
   * Build a prompt instructing the agent to install missing STT dependencies.
   */
  private buildSttInstallPrompt(missing: string[], attachments: any[]): string {
    const audioFile = attachments.find((a: any) => a.mediaType === "audio");
    const audioPath = audioFile?.localPath ?? "(audio file path from attachment)";

    const parts: string[] = [
      "The user sent a voice message but speech-to-text transcription failed because dependencies are missing.",
      "",
      `Missing: ${missing.join(", ")}`,
      "",
      "Please install the missing dependencies:",
    ];

    if (missing.includes("ffmpeg")) {
      parts.push("- ffmpeg: Install to ~/.local/bin/ffmpeg (try: curl static binary from johnvansickle.com for Linux, or `brew install ffmpeg` on macOS)");
    }
    if (missing.includes("whisper")) {
      parts.push("- whisper: Install via `pip3 install --user openai-whisper` or `uv tool install openai-whisper`");
    }

    parts.push("");
    parts.push("After installing, verify with `whisper --help` and `ffmpeg -version`, then transcribe the voice message:");
    parts.push(`  whisper ${JSON.stringify(audioPath)} --model small --language en --output_format txt --output_dir /tmp`);
    parts.push("");
    parts.push("Send the transcription text back to the user. If installation fails, let the user know what went wrong.");

    return parts.join("\n");
  }

  /**
   * Save attachments, notify skipped, and build the AgentMessage.
   * Returns null if there's nothing to send (empty text + failed attachments).
   */
  private async prepareAgentMessage(
    thread: any, agentThreadId: string, userText: string, rawAttachments: any[],
  ): Promise<AgentMessage | null> {
    let attachmentResult: AttachmentResult = { saved: [], skipped: [] };
    try {
      attachmentResult = await saveAttachments(agentThreadId, rawAttachments);
    } catch (err) {
      console.error(`[roundhouse] saveAttachments error:`, (err as Error).message);
      if (!userText.trim()) {
        try { await thread.post("⚠️ Failed to process attachment(s). Please try again."); } catch {}
        return null;
      }
    }

    if (attachmentResult.skipped.length > 0) {
      const skipMsg = attachmentResult.skipped.map((s) => `\u2022 ${s}`).join("\n");
      try { await thread.post(`⚠️ Some attachments were skipped:\n${skipMsg}`); } catch {}
    }

    const promptText = userText.trim();
    const agentMessage: AgentMessage = {
      text: promptText,
      attachments: attachmentResult.saved.length > 0 ? attachmentResult.saved : undefined,
    };

    if (!promptText && !agentMessage.attachments) {
      if (rawAttachments.length > 0) {
        try { await thread.post("⚠️ Failed to save attachment(s). Please try again."); } catch {}
      }
      return null;
    }

    // Enrich prompt via transport adapter (composite routes by ownsThread).
    if (agentMessage.text) {
      agentMessage.text = this.transport.enrichPrompt(thread, agentMessage.text);
    }

    return agentMessage;
  }

  /**
   * Handle context pressure — flush memory and/or compact.
   * Soft: runs OUTSIDE the thread lock (non-blocking to user messages).
   * Hard/emergency: runs INSIDE the thread lock (memory state invariants).
   */
  private async handleContextPressure(thread: any, agentThreadId: string, agent: AgentAdapter, memoryRoot: string, pressure: PressureLevel) {
    if (pressure === "none") return;

    if (pressure === "soft") {
      // Soft: prompt agent to save facts, no compact
      // Cooldown is checked inside flushMemoryThenCompact (returns null if skipped)
      try {
        const result = await flushMemoryThenCompact(agentThreadId, agent, memoryRoot, "soft", this.config.memory);
        // result is null if cooldown skipped OR if soft flush ran (soft always returns null)
        // Log only — don't message user for soft flush (it's background housekeeping)
      } catch (err) {
        console.error(`[roundhouse] soft flush error:`, (err as Error).message);
      }
      return;
    }

    // Hard or emergency: flush + compact
    try {
      const prefix = pressure === "emergency" ? "⚠️ Context nearly full! " : "";
      const progress = await this.transport.progress(thread, `📝 ${prefix}Saving memory and compacting...`);
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
    allowedUsers: string[], allowedUserIds: (string | number)[],
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
      progress: (t, initialText) => this.transport.progress(t, initialText),
      stopGateway: () => this.stop(),
    };
  }

  /**
   * Build the full list of command descriptors.
   *
   * Each descriptor self-describes its triggers, dispatch stage, argument
   * acceptance, and optional inline-keyboard action handlers. The gateway
   * iterates this list — no per-command branching in the message handler.
   *
   * Stage:
   *   - "in-turn" (default): runs after allowlist + pairing inside handle()
   *   - "pre-turn": runs first in handleOrAbort() so commands like /cancel
   *     can interrupt an in-flight agent turn
   *
   * Per-request state (thread, message, text) comes in via CommandInvocation;
   * long-lived deps (cronScheduler, verboseThreads, abortControllers, …) are
   * captured here from the surrounding start() closure.
   */
  private buildCommandDescriptors(deps: {
    allowedUsers: string[];
    allowedUserIds: (string | number)[];
    verboseThreads: Set<string>;
    threadLocks: Map<string, Promise<void>>;
    abortControllers: Map<string, AbortController>;
  }): CommandDescriptor[] {
    const { allowedUsers, allowedUserIds, verboseThreads, threadLocks, abortControllers } = deps;
    const post = (t: any, txt: string) => this.postWithFallback(t, txt);

    // Shorthand: wrap a standard-CommandContext handler as a descriptor invoker.
    const withCtx = (handler: (ctx: CommandContext) => Promise<void>) =>
      async ({ thread, message, agentThreadId }: CommandInvocation) => {
        // CommandInvocation.message is loosely typed (`text` + index sig);
        // narrow to the shape we read here.
        const authorish = message as { author?: { userName?: string; userId?: string | number } };
        const authorName = authorish.author?.userName ?? authorish.author?.userId ?? "?";
        await handler(this.buildCommandContext(
          thread, message, agentThreadId, String(authorName),
          allowedUsers, allowedUserIds, verboseThreads, threadLocks,
        ));
      };

    return [
      // ── Standard CommandContext commands (in-turn, no args) ──
      { triggers: ["/new"],     invoke: withCtx(handleNew) },
      { triggers: ["/restart"], invoke: withCtx(handleRestart) },
      { triggers: ["/update"],  invoke: withCtx(handleUpdate) },
      { triggers: ["/compact"], invoke: withCtx(handleCompact) },
      { triggers: ["/status"],  invoke: withCtx(handleStatus) },

      // ── In-turn commands that accept args ──
      {
        triggers: ["/model"],
        acceptsArgs: true,
        invoke: ({ text }) => handleModel({ text }),
        actions: {
          [MODEL_ACTION_ID]: (ev) => handleModelAction({ value: ev.value }),
        },
      },
      {
        triggers: ["/later"],
        acceptsArgs: true,
        invoke: ({ thread, text }) => handleLater({ thread, text, postWithFallback: post }),
      },
      {
        triggers: ["/topic"],
        acceptsArgs: true,
        invoke: ({ thread, text }) => handleTopic({ thread, text }),
        actions: {
          [TOPIC_ACTION_ID]: (ev) => handleTopicAction({ value: ev.value, thread: ev.thread }),
        },
      },

      // ── Pre-turn commands (abort-style; fire even during agent turn) ──
      {
        triggers: ["/cancel"],
        stage: "pre-turn",
        invoke: ({ thread, agentThreadId }) => handleCancel({
          thread, agentThreadId,
          agent: this.router.resolve(agentThreadId),
          abortControllers,
        }),
      },
      {
        triggers: ["/verbose"],
        stage: "pre-turn",
        invoke: ({ thread, agentThreadId }) => handleVerbose({
          thread, agentThreadId, verboseThreads,
        }),
      },
      {
        triggers: ["/doctor"],
        stage: "pre-turn",
        invoke: ({ thread }) => handleDoctor({
          thread, runDoctor, createDoctorContext, formatDoctorTelegram,
          postWithFallback: post,
        }),
      },
      {
        triggers: ["/crons", "/jobs"],
        stage: "pre-turn",
        acceptsArgs: true,
        invoke: ({ thread, text }) => handleCrons({
          thread, text,
          cronScheduler: this.cronScheduler,
          progress: (t, initialText) => this.transport.progress(t, initialText),
        }),
      },
    ];
  }

  private async handleStreaming(thread: any, stream: AsyncIterable<AgentStreamEvent>, verbose: boolean, signal?: AbortSignal): Promise<{ usedTools: boolean; hadVisibleText: boolean }> {
    return _handleStream(stream, {
      thread,
      verbose,
      signal,
      postWithFallback: (t, text) => this.postWithFallback(t, text),
      transport: this.transport,
    });
  }

  /**
   * Walk the in-turn descriptor list, invoking the first matching command
   * and forwarding its result via postCommandResult.
   *
   * Extracted so tests can exercise the *live* dispatch path (and prove
   * that the original transport thread reaches transport.postRich, not a
   * synthetic one rewritten with the agent thread id) without booting a
   * real Chat SDK instance.
   *
   * @returns true if a command matched and was handled, false otherwise.
   */
  private async dispatchInTurnCommand(
    inTurnCommands: readonly CommandDescriptor[],
    thread: any,
    botUsername: string,
    message: unknown,
    trimmed: string,
    agentThreadId: string,
  ): Promise<boolean> {
    const matchers = buildMatchers(botUsername);  // Reuse shared factory
    const inv: CommandInvocation = { thread, message: message as { text?: string; [key: string]: unknown }, text: trimmed, agentThreadId };
    for (const desc of inTurnCommands) {
      if (matchesDescriptor(desc, trimmed, matchers)) {
        const result = await desc.invoke(inv);
        await this.postCommandResult(thread, result);
        return true;
      }
    }
    return false;
  }

  /**
   * Dispatch a command's result to the active transport.
   *
   * - `void` return: the command handled its own posting (legacy path).
   * - `RichResponse`: render via `transport.postRich()`.
   *
   * Centralising this means a new menu-style command only has to return
   * data — it never imports a transport package directly.
   *
   * **Trust the postRich never-throws contract.** `TransportAdapter.postRich`
   * is documented to never throw; adapters degrade gracefully internally
   * (Telegram does this via `safePostText`). We don't add a fallback
   * `thread.post(text)` here — if an adapter ever does throw, the error
   * propagates and surfaces as a bug rather than being silently swallowed.
   *
   * `thread: any` mirrors the rest of the gateway: the chat SDK Thread<TRaw>
   * type doesn't flow cleanly through this surface yet (would require a
   * bigger generic-threading refactor across helpers/streaming), so we
   * keep this loose. The transport adapter narrows again in postRich.
   */
  private async postCommandResult(thread: any, result: CommandResult): Promise<void> {
    if (!result) return;
    await this.transport.postRich(thread, result);
  }

  /** Post text with markdown, falling back to plain text */
  private async postWithFallback(thread: any, text: string) {
    if (this.transport.ownsThread(thread)) {
      await this.transport.postMessage(thread, text);
      return;
    }
    for (const chunk of splitMessage(text, MAX_MESSAGE_CHUNK)) {
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
   * Register bot commands with each configured platform so they appear in
   * its / menu (Telegram) or app config (Slack — no-op at runtime).
   * Each delegate self-sources its own creds and no-ops if they're missing,
   * so the gateway calls unconditionally.
   */
  private async registerBotCommands() {
    await this.transport.registerCommands();
  }

  /**
   * Wire `bot.onAssistantThreadStarted` → composite.handlePairing.
   *
   * Slack fires this when the user opens an assistant DM with the bot,
   * BEFORE the user types anything. Without this hook, the first-DM
   * pairing path can deadlock: `message.im` only fires for *existing* DMs,
   * so a user who just clicked "Message" on the bot's profile has no DM
   * channel yet and never produces an event.
   *
   * We synthesize an IncomingMessage with the user's display name resolved
   * via `slackSdk.getUser(userId)` so the pending pairing's allowedUsers
   * check (which compares lowercased userName) succeeds.
   */
  private registerAssistantThreadStartedHandler(): void {
    const slackDelegate = this.transport.delegates.find((d) => d.name === "slack") as SlackAdapter | undefined;
    if (!slackDelegate) return;

    // chat.onAssistantThreadStarted is the public registration on ChatInstance
    // (chat@4.29.0 chat-D9UYaaNO.d.ts:2913). Cast here is just to match the
    // local Chat type that elides the assistant API.
    const bot = this.chat as unknown as {
      onAssistantThreadStarted?: (handler: (event: any) => Promise<void> | void) => void;
      getAdapter(name: string): { getUser?(userId: string): Promise<{ userName?: string; fullName?: string } | null> } | undefined;
    };

    if (!bot.onAssistantThreadStarted) {
      console.warn("[roundhouse] chat instance doesn't expose onAssistantThreadStarted; skipping");
      return;
    }

    bot.onAssistantThreadStarted(async (event: { userId: string; channelId: string; threadTs: string }) => {
      try {
        const slackSdk = bot.getAdapter("slack");
        const userInfo = slackSdk?.getUser ? await slackSdk.getUser(event.userId).catch(() => null) : null;
        // Synthesize a thread that ownsThread('slack:…') and a message that
        // matches the IncomingMessage shape the existing pairing pipeline expects.
        const syntheticThread = this.transport.createThread(event.channelId);
        const syntheticMessage = {
          text: "",
          author: {
            userId: event.userId,
            userName: userInfo?.userName,
            name: userInfo?.fullName,
          },
          chatId: event.channelId,
          raw: event,
        };
        const handled = await this.handlePendingPairing(syntheticMessage, syntheticThread);
        if (handled) {
          console.log(`[roundhouse] slack pairing completed via assistant_thread_started for ${event.userId}`);
        }
      } catch (err) {
        console.error("[roundhouse] assistant_thread_started handler failed:", (err as Error).message);
      }
    });
  }

  /**
   * Send a startup notification to configured chat IDs.
   * Multi-transport: each chatId is routed by `ownsChatId`; the
   * "Session: …" label is delegated to `transport.formatNotifySession`
   * so platform-specific semantics (Telegram negative-id = group, Slack
   * `Dxxx` = DM) live in the adapter, not here.
   */
  private async notifyStartup(platforms: string) {
    const chatIds = this.config.chat.notifyChatIds;
    if (!chatIds?.length) return;

    const bootTime = process.uptime();
    const host = hostname();
    const agentName = this.config.agent.type;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const nodeVer = process.version;
    const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);
    const sys = _getSysRes();

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

    // Check if this is a fresh update (call once, before loop)
    const whatsNew = checkVersionChange();

    for (const chatId of chatIds) {
      const sessionId = this.transport.formatNotifySession(chatId);
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

      const fullText = whatsNew ? `${perChatText}\n\n${whatsNew}` : perChatText;
      await this.transport.notify([chatId], fullText);
    }
  }

  /**
   * Fire a boot turn — send a prompt to the agent so it greets in-character.
   * Seeds the session on startup so context is never empty.
   *
   * Multi-transport: fire one boot turn per transport that has at least one
   * configured chat id, against the FIRST chat id owned by that transport.
   * This ensures both Telegram and Slack get a "hello" on the same gateway
   * boot, instead of a global `chatIds[0]` which would silently favor
   * whichever transport happened to be listed first.
   */
  private async fireBootTurn(
    verboseThreads: Set<string>,
    threadLocks: Map<string, Promise<void>>,
    abortControllers: Map<string, AbortController>,
  ) {
    const chatIds = this.config.chat.notifyChatIds;
    if (!chatIds?.length) return;

    const bootPrompt = "You just came online after a restart. Say a brief hello in-character (1–2 sentences max). Check your workspace for any pending tasks.";

    // Pick the first chatId owned by each delegate (deduplicated by transport name).
    const seenTransports = new Set<string>();
    const primaryPerTransport: Array<{ transport: string; chatId: string | number }> = [];
    for (const chatId of chatIds) {
      const owner = this.transport.ownerOfChatId(chatId);
      if (!owner || seenTransports.has(owner.name)) continue;
      seenTransports.add(owner.name);
      primaryPerTransport.push({ transport: owner.name, chatId });
    }

    for (const { transport, chatId } of primaryPerTransport) {
      try {
        // Derive per-transport boot session id (not global "main")
        // This ensures each transport seeds its own session, not cross-contaminated
        const agentThreadId = this.transport.encodeParentThreadId(chatId);
        const syntheticThread = this.transport.createThread(chatId);
        await this.handleAgentTurn(syntheticThread, agentThreadId, bootPrompt, [], verboseThreads, threadLocks, abortControllers, "boot");
      } catch (err) {
        console.error(`[roundhouse] boot turn (${transport}) failed:`, (err as Error).message);
      }
    }
  }

  async stop() {
    if (this.subagentWatcher) {
      this.subagentWatcher.stop();
    }
    if (this.ipcServer) {
      this.ipcServer.stop();
    }
    if (this.cronScheduler) {
      try { await this.cronScheduler.stop(); } catch (e) { console.warn("[roundhouse] cron stop error:", e); }
    }
    try { await this.chat?.shutdown(); } catch (e) { console.warn("[roundhouse] chat shutdown error:", e); }
    await this.router.dispose();
    console.log("[roundhouse] stopped");
  }

  /** Handle sub-agent completion — notify user AND inject result into agent session */
  private async handleSubagentCompletion(status: RunStatus, routing: RoutingInfo): Promise<void> {
    const chatId = routing.chatId;
    if (!chatId) return;

    await this.notifySubagentResult(status, chatId);
    await this.injectSubagentResult(status, chatId);
  }

  /** Notify user of sub-agent completion via transport */
  private async notifySubagentResult(status: RunStatus, chatId: string | number): Promise<void> {
    const emoji = status.status === "complete" ? "✅" : status.status === "timeout" ? "⏰" : "❌";
    const duration = status.completedAt && status.startedAt
      ? Math.round((Date.parse(status.completedAt) - Date.parse(status.startedAt)) / 1000)
      : 0;
    const summary = `${emoji} **Sub-agent ${status.status}** (${status.role})\n⏱ ${duration}s | run: \`${status.runId.slice(0, 8)}\``;
    try {
      await this.transport.notify([chatId], summary);
    } catch (err) {
      console.error("[roundhouse] sub-agent completion notification failed:", err);
    }
  }

  /** Inject sub-agent output into agent session as synthetic turn */
  private async injectSubagentResult(status: RunStatus, chatId: string | number): Promise<void> {
    try {
      const runDir = join(process.env.HOME || "/home/ec2-user", ".roundhouse", "subagents", status.runId);
      let stdout = "";
      try { stdout = await readFile(join(runDir, "stdout.log"), "utf-8"); } catch {}

      const resultText = stdout.trim()
        ? `[Sub-agent ${status.role} completed (${status.status})]\n\nResult:\n${stdout.trim().slice(0, MAX_SUBAGENT_STDOUT_CHARS)}`
        : `[Sub-agent ${status.role} ${status.status} — no output]`;

      const syntheticThread = this.transport.createThread(chatId);
      await this.handleAgentTurn(syntheticThread, "main", resultText, [], this.verboseThreads, this.threadLocks, this.abortControllers, "subagent");
    } catch (err) {
      console.error("[roundhouse] sub-agent result injection failed:", err);
    }
  }
}

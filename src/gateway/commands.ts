/**
 * gateway/commands.ts — Chat command handlers
 *
 * Each handler is a standalone async function that receives a CommandContext.
 * Extracted from Gateway.start() to reduce method size and enable unit testing.
 */

import type { AgentAdapter, AgentStreamEvent, GatewayConfig } from "../types";
import type { ChatThread, RichResponse, ProgressMessage } from "../transports";
import { ROUNDHOUSE_VERSION } from "../config";
import { startTypingLoop } from "../util";
import { prepareMemoryForTurn, finalizeMemoryForTurn, flushMemoryThenCompact, determineMemoryMode } from "../memory/lifecycle";
import { getSystemResources } from "./helpers";
import { contextThresholds } from "../memory/policy";
import { loadThreadMemoryState, saveThreadMemoryState } from "../memory/state";

// ── Types ────────────────────────────────────────────

export interface CommandContext {
  thread: any;
  message: any;
  agentThreadId: string;
  authorName: string;
  agent: AgentAdapter;
  config: GatewayConfig;
  allowedUsers: string[];
  allowedUserIds: (string | number)[];
  verboseThreads: Set<string>;
  threadLocks: Map<string, Promise<void>>;
  postWithFallback: (thread: any, text: string) => Promise<void>;
  /** Open a transport-rendered progress message (post + edit-in-place). */
  progress: (thread: ChatThread, initialText: string) => Promise<ProgressMessage>;
  /** What a typing loop should drive for this thread (see Gateway.typingTarget). */
  typingTarget?: (thread: any) => { startTyping: (status?: string) => Promise<void>; stopTyping?: () => Promise<void> | void };
  stopGateway: () => Promise<void>;
}

// ── /new ─────────────────────────────────────────────

export async function handleNew(ctx: CommandContext): Promise<void> {
  const { thread, agent, agentThreadId } = ctx;
  if (agent.restart) {
    await agent.restart(agentThreadId);
    // The new conversation starts without the old one's context, so it needs
    // the memory files again, and its own count for the next soft flush.
    try {
      const state = await loadThreadMemoryState(agentThreadId);
      state.forceInjectReason = "new-session";
      state.lastSoftFlushTokens = undefined;
      state.pendingCompact = undefined;
      await saveThreadMemoryState(agentThreadId, state);
    } catch (err) {
      console.warn(`[roundhouse] /new: could not reset memory state:`, (err as Error).message);
    }
    await thread.post(`🔄 New conversation started (\`${agentThreadId}\`). The previous one is kept on disk; your next message begins the new one.`);
  } else {
    await thread.post("⚠️ New session not supported for this agent.");
  }
  console.log(`[roundhouse] /new for thread=${thread.id} agentThread=${agentThreadId}`);
}

// ── /restart ─────────────────────────────────────────

export async function handleRestart(ctx: CommandContext): Promise<void> {
  const { thread, authorName, allowedUsers, allowedUserIds, stopGateway } = ctx;
  if (allowedUsers.length === 0 && allowedUserIds.length === 0) {
    await thread.post("⚠️ /restart requires an allowlist (allowedUsers or allowedUserIds) to be configured.");
    return;
  }
  console.log(`[roundhouse] /restart requested by @${authorName} in thread=${thread.id}`);
  await thread.post("🔄 Restarting gateway...");
  setTimeout(async () => {
    console.log("[roundhouse] shutting down for restart");
    try { await stopGateway(); } catch (e) { console.error("[roundhouse] stop error:", e); }
    process.exit(75);
  }, 1000);
}

// ── /update ──────────────────────────────────────────

export async function handleUpdate(ctx: CommandContext): Promise<void> {
  const { thread, authorName, allowedUsers, allowedUserIds, stopGateway } = ctx;
  if (allowedUsers.length === 0 && allowedUserIds.length === 0) {
    await thread.post("⚠️ /update requires an allowlist to be configured.");
    return;
  }
  // /update replaces the running code with whatever npm publishes as latest
  // and re-runs the provisioning bundle on the host. Hosts that run a pinned
  // or reviewed copy turn it off with chat.allowUpdateCommand=false.
  if (ctx.config.chat.allowUpdateCommand === false) {
    await thread.post("⚠️ /update is disabled on this host (chat.allowUpdateCommand=false). Update it from the machine itself.");
    return;
  }
  // Seed .last-version with current version BEFORE update, so new code detects the change on restart
  try {
    const { ROUNDHOUSE_DIR, ROUNDHOUSE_VERSION } = await import("../config");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(ROUNDHOUSE_DIR, { recursive: true });
    writeFileSync(join(ROUNDHOUSE_DIR, ".last-version"), ROUNDHOUSE_VERSION + "\n");
  } catch {}
  console.log(`[roundhouse] /update requested by @${authorName} in thread=${thread.id}`);
  const progress = await ctx.progress(thread, "📦 Checking for updates...");
  try {
    const { performUpdate } = await import("../cli/update");
    const result = await performUpdate(progress);
    if (result.action === "already-latest") {
      await progress.update(`✅ Already on latest (v${result.currentVersion})`);
    } else if (result.action === "error") {
      await progress.update(`⚠️ ${(result.error ?? "Update failed").slice(0, 200)}`);
    } else if (result.action === "updated") {
      await progress.update(`✅ Updated v${result.currentVersion} → v${result.latestVersion}. Restarting...`);
      console.log(`[roundhouse] updated ${result.currentVersion} -> ${result.latestVersion}, restarting`);
      setTimeout(async () => {
        try { await stopGateway(); } catch (e) { console.error("[roundhouse] stop error:", e); }
        process.exit(75);
      }, 1500);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await progress.update(`⚠️ Update failed: ${msg.slice(0, 200)}`);
    console.error(`[roundhouse] /update failed:`, msg);
  }
}

// ── /compact ─────────────────────────────────────────

export async function handleCompact(ctx: CommandContext): Promise<void> {
  const { thread, agent, agentThreadId, config, threadLocks } = ctx;
  if (!agent.compact) {
    await thread.post("⚠️ Compaction not supported for this agent.");
    return;
  }
  console.log(`[roundhouse] /compact for thread=${thread.id} agentThread=${agentThreadId}`);

  // Acquire per-thread lock
  const prevLock = threadLocks.get(agentThreadId);
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
  threadLocks.set(agentThreadId, lockPromise);
  if (prevLock) await prevLock;

  const progress = await ctx.progress(thread, "📝 Saving memory and compacting...");
  const stopTyping = startTypingLoop(ctx.typingTarget ? ctx.typingTarget(thread) : thread);
  try {
    const agentCwd = (agent.getInfo?.()?.cwd as string) ?? process.cwd();
    const memoryRoot = config.memory?.rootDir ?? agentCwd;

    if (config.memory?.enabled === false) {
      const result = await agent.compact(agentThreadId);
      if (!result) {
        await progress.update("⚠️ No active session to compact. Send a message first.");
      } else {
        const beforeK = (result.tokensBefore / 1000).toFixed(1);
        await progress.update(`✅ Compaction complete\n\nCompacted ${beforeK}K tokens down to a summary.\nContext usage will update after your next message.`);
      }
    } else {
      const result = await flushMemoryThenCompact(
        agentThreadId, agent, memoryRoot, "manual", config.memory,
        (step) => progress.update(step),
      );
      if (!result) {
        await progress.update("⚠️ No active session to compact. Send a message first.");
      } else {
        const beforeK = (result.tokensBefore / 1000).toFixed(1);
        const timing = result.timing;
        const timingLine = timing ? `\nTiming: flush ${(timing.flushMs / 1000).toFixed(1)}s, compact ${(timing.compactMs / 1000).toFixed(1)}s, total ${(timing.totalMs / 1000).toFixed(1)}s\nModel: ${timing.model}` : "";
        await progress.update(`✅ Memory saved & compacted\n\nCompacted ${beforeK}K tokens down to a summary.\nContext usage will update after your next message.${timingLine}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await progress.update(`⚠️ Compaction failed: ${msg.slice(0, 200)}`);
  } finally {
    stopTyping();
    releaseLock!();
    if (threadLocks.get(agentThreadId) === lockPromise) {
      threadLocks.delete(agentThreadId);
    }
  }
}

// ── /status ──────────────────────────────────────────

// ── Status helpers ────────────────────────────────────────

function formatUptime(sec: number): string {
  return sec < 3600
    ? `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`
    : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// `npm view` takes seconds and /status should answer at once, so the answer
// is remembered for a few hours and refreshed in the background.
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
let updateCheck: { at: number; latest: string } | undefined;
let updateCheckRunning = false;

function cachedAvailableUpdate(): string {
  if ((!updateCheck || Date.now() - updateCheck.at > UPDATE_CHECK_TTL_MS) && !updateCheckRunning) {
    updateCheckRunning = true;
    void checkAvailableUpdate()
      // A lookup that failed (null) is tried again in ten minutes rather
      // than remembered as "no update" for hours.
      .then((latest) => { updateCheck = { at: latest === null ? Date.now() - UPDATE_CHECK_TTL_MS + 10 * 60_000 : Date.now(), latest: latest ?? updateCheck?.latest ?? "" }; })
      .finally(() => { updateCheckRunning = false; });
  }
  return updateCheck?.latest ?? "";
}

async function checkAvailableUpdate(): Promise<string | null> {
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    const { stdout } = await execAsync("npm view @inceptionstack/roundhouse version 2>/dev/null", { timeout: 10_000 });
    const latest = stdout.trim().split("\n").pop()!.trim();
    if (latest && /^\d+\.\d+\.\d+$/.test(latest) && latest !== ROUNDHOUSE_VERSION) {
      const [lM, lm, lp] = latest.split(".").map(Number);
      const [cM, cm, cp] = ROUNDHOUSE_VERSION.split(".").map(Number);
      if (lM > cM || (lM === cM && lm > cm) || (lM === cM && lm === cm && lp > cp)) {
        return latest;
      }
    }
  } catch {
    return null; // network unavailable
  }
  return "";
}

export async function handleStatus(ctx: CommandContext): Promise<void> {
  const { thread, agent, agentThreadId, config, allowedUsers, verboseThreads, postWithFallback } = ctx;

  const uptimeStr = formatUptime(process.uptime());
  const platforms = Object.keys(config.chat.adapters).join(", ");
  const debugStream = process.env.ROUNDHOUSE_DEBUG_STREAM === "1";
  const nodeVer = process.version;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);
  const updateAvailable = cachedAvailableUpdate();

  const info = agent.getInfo ? agent.getInfo(agentThreadId) : {};
  const agentVersion = info.version ? `v${info.version}` : "";
  const agentLabel = agentVersion ? `\`${agent.name}\` (${agentVersion})` : `\`${agent.name}\``;

  const versionLine = updateAvailable
    ? `📦 Roundhouse: v${ROUNDHOUSE_VERSION} → ⬆️ v${updateAvailable} available (/update)`
    : `📦 Roundhouse: v${ROUNDHOUSE_VERSION}`;

  const lines = [
    `📊 *Roundhouse Status*`,
    ``,
    `🎫 Session: \`${agentThreadId}\``,
    versionLine,
    `🤖 Agent: ${agentLabel}`,
  ];

  if (info.model && info.model !== "unknown") {
    const configuredModel = info.configuredModel as string | undefined;
    if (configuredModel && configuredModel !== info.model && info.hasActiveSession) {
      lines.push(`🧠 Model: \`${info.model}\``);
      lines.push(`   ↳ default for new conversations: \`${configuredModel}\` (/model switches this one)`);
    } else {
      lines.push(`🧠 Model: \`${configuredModel || info.model}\``);
    }
  } else if (info.configuredModel) {
    lines.push(`🧠 Model: \`${info.configuredModel}\``);
  }
  if (info.activeSessions !== undefined) lines.push(`💬 Active sessions: ${info.activeSessions}`);

  lines.push(
    `🌐 Platforms: ${platforms}`,
    `👤 Bot: @${config.chat.botUsername}`,
    `⏱ Uptime: ${uptimeStr}`,
    `💾 Memory: ${memMB} MB`,
    `🟢 Node: ${nodeVer}`,
    `🔧 Debug stream: ${debugStream ? "on" : "off"}`,
    `📢 Verbose: ${verboseThreads.has(agentThreadId) ? "on" : "off"}`,
  );

  // Paired ids are what authorize; usernames only count before pairing.
  const idCount = ctx.allowedUserIds.length;
  const access = idCount > 0
    ? `${idCount} paired id${idCount === 1 ? "" : "s"}`
    : allowedUsers.length > 0
      ? `${allowedUsers.length} username${allowedUsers.length === 1 ? "" : "s"} (not paired yet)`
      : config.chat.allowAll === true ? "everyone (chat.allowAll)" : "nobody (no allowlist)";
  lines.push(`🔐 Allowed users: ${access}`);

  const sys = getSystemResources();
  lines.push(``);
  lines.push(`🖥 *System*`);
  lines.push(`   CPU: ${sys.cpuPct}% (load ${sys.load1.toFixed(2)}, ${sys.cpuCount} cores)`);
  lines.push(`   RAM: ${sys.usedGB}/${sys.totalGB} GB (${sys.memPct}%)`);
  lines.push(`   Process: ${memMB} MB RSS`);

  const memMode = determineMemoryMode(info);
  const memEnabled = config.memory?.enabled !== false;
  const memLabel = !memEnabled ? "disabled"
    : memMode === "complement" ? "agent-managed (pi-memory)"
    : memMode === "full" ? "roundhouse-managed"
    : "pending detection";
  lines.push(``);
  lines.push(`🧠 Memory: ${memLabel}`);

  if (typeof info.contextTokens === "number" && typeof info.contextWindow === "number" && info.contextWindow > 0) {
    const pct = Math.min(100, Math.round((info.contextTokens as number) / (info.contextWindow as number) * 100));
    const barLen = 20;
    const filled = Math.round(pct / 100 * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const tokensK = ((info.contextTokens as number) / 1000).toFixed(1);
    const windowK = ((info.contextWindow as number) / 1000).toFixed(0);
    lines.push(``);
    lines.push(`📝 Context: \`${bar}\` ${pct}%`);
    lines.push(`   ${tokensK}K / ${windowK}K tokens`);
  } else if (typeof info.contextWindow === "number" && info.contextWindow > 0) {
    const windowK = ((info.contextWindow as number) / 1000).toFixed(0);
    lines.push(``);
    lines.push(`📝 Context: no usage data yet (${windowK}K window)`);
  }
  if (typeof info.thinkingLevel === "string") lines.push(`   Thinking: ${info.thinkingLevel} (/think)`);
  if (typeof info.sessionCost === "number" && info.sessionTokens) {
    const t = info.sessionTokens as { input: number; output: number; cacheRead: number; cacheWrite: number };
    const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
    lines.push(`   This conversation so far: $${(info.sessionCost as number).toFixed(2)} (in ${k(t.input)}, cached ${k(t.cacheRead)}, cache writes ${k(t.cacheWrite)}, out ${k(t.output)})`);
  }
  // When this conversation will be compacted, for the model it is on.
  if (typeof info.contextWindow === "number" && info.contextWindow > 0 && memEnabled && config.memory?.compact?.enabled !== false) {
    const model = typeof info.model === "string" ? info.model : null;
    const t = contextThresholds(info.contextWindow as number, config.memory?.compact, model);
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    lines.push(`   Saves memory at ${k(t.soft)}, compacts at ${k(t.hard)}`);
  }

  const extensions = Array.isArray(info.extensions) ? info.extensions as string[] : [];
  if (extensions.length > 0) {
    lines.push(``);
    lines.push(`🧩 Extensions (${extensions.length}):`);
    for (const ext of extensions) {
      const short = ext.replace(/^.*node_modules\//, "").replace(/\/index\.[tj]s$/, "");
      lines.push(`   • ${short}`);
    }
  }

  await postWithFallback(thread, lines.join("\n"));
  console.log(`[roundhouse] /status for thread=${thread.id} agentThread=${agentThreadId}`);
}

// ── /cancel ────────────────────────────────────────────

export interface CancelContext {
  thread: any;
  agentThreadId: string;
  agent: AgentAdapter;
  abortControllers: Map<string, AbortController>;
  /** Abort signal of the turn running in this chat, if the gateway knows of one. */
  running?: AbortController;
}

export async function handleCancel(ctx: CancelContext): Promise<void> {
  const { thread, agentThreadId, agent, abortControllers } = ctx;
  if (agent.abort) {
    const controller = ctx.running ?? abortControllers.get(agentThreadId);
    // The gateway's signal first: it also stops a turn that has not reached
    // the model yet. Then the agent, for whatever it is doing right now
    // (a tool, a model call, a compaction).
    controller?.abort();
    await agent.abort(agentThreadId);
    try {
      await thread.post(controller ? "⏹️ Cancelled." : "⏹️ Nothing is running in this chat right now.");
    } catch {}
  } else {
    try { await thread.post("⚠️ Abort not supported for this agent."); } catch {}
  }
  console.log(`[roundhouse] /cancel for thread=${thread.id} agentThread=${agentThreadId}`);
}

// ── /verbose ─────────────────────────────────────────

export interface VerboseContext {
  thread: any;
  agentThreadId: string;
  verboseThreads: Set<string>;
}

export async function handleVerbose(ctx: VerboseContext): Promise<void> {
  const { thread, agentThreadId, verboseThreads } = ctx;
  if (verboseThreads.has(agentThreadId)) {
    verboseThreads.delete(agentThreadId);
    try { await thread.post("🔇 Verbose mode OFF — tool status messages hidden."); } catch {}
  } else {
    verboseThreads.add(agentThreadId);
    try { await thread.post("📢 Verbose mode ON — showing tool calls."); } catch {}
  }
  console.log(`[roundhouse] /verbose for thread=${thread.id} agentThread=${agentThreadId} -> ${verboseThreads.has(agentThreadId) ? "on" : "off"}`);
}

// ── /doctor ──────────────────────────────────────────

export interface DoctorContext {
  thread: any;
  runDoctor: (ctx: any) => Promise<any>;
  createDoctorContext: () => Promise<any>;
  formatDoctorTelegram: (results: any) => string;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

export async function handleDoctor(ctx: DoctorContext): Promise<void> {
  const { thread, runDoctor, createDoctorContext, formatDoctorTelegram, postWithFallback } = ctx;
  const { startTypingLoop } = await import("../util");
  const stopTyping = startTypingLoop(thread);
  try {
    const results = await runDoctor(await createDoctorContext());
    const report = formatDoctorTelegram(results);
    await postWithFallback(thread, report);
  } catch (err) {
    try { await thread.post(`⚠️ Doctor failed: ${(err as Error).message}`); } catch {}
  } finally {
    stopTyping();
  }
  console.log(`[roundhouse] /doctor for thread=${thread.id}`);
}

// ── /crons (/jobs) ───────────────────────────────────

export interface CronsContext {
  thread: any;
  text: string;
  cronScheduler: any | null;
  /**
   * Transport-rendered progress message factory. Used by `/crons trigger`
   * for the eager "queued…" → "✅ queued" two-phase update so adapters
   * that support edit-in-place don't post two separate bubbles.
   * Adapters that can't edit fall back to a single post + no-op updates.
   */
  progress: (thread: ChatThread, initialText: string) => Promise<ProgressMessage>;
}

export async function handleCrons(ctx: CronsContext): Promise<RichResponse | void> {
  const { thread, text, cronScheduler } = ctx;
  const { startTypingLoop } = await import("../util");
  const { isBuiltinJob } = await import("../cron/helpers");
  const { formatSchedule, formatRunCounts, jobEnabledIcon } = await import("../cron/format");

  // Typing indicator while we look up scheduler state. Best-effort.
  const stopTyping = startTypingLoop(thread);
  try {
    const parts = text.split(/\s+/).slice(1);
    const sub = parts[0];
    const id = parts[1];

    if (!cronScheduler) {
      return { text: "⚠️ Cron scheduler not running." };
    }

    if (sub === "trigger" && id) {
      if (isBuiltinJob(id)) return { text: `⚠️ ${id} is a built-in job and cannot be triggered manually.` };
      // Edit-in-place via transport.progress(): "⏳ Triggering…" → "✅ queued"
      // (or "❌ failed") so we don't litter the chat with two bubbles.
      // Adapters without edit support degrade to a single post + no-op update.
      //
      // We deliberately do NOT rethrow on failure: progress.update(❌) has
      // already communicated the failure to the user, and rethrowing would
      // surface a *second* generic error from the gateway's catch-all.
      // Mirrors the rest of handleCrons returning RichResponse for failures.
      const progress = await ctx.progress(thread, `⏳ Triggering ${id}...`);
      try {
        await ctx.cronScheduler.trigger(id);
        await progress.update(`✅ ${id} queued.`);
      } catch (err) {
        console.error(`[roundhouse] /crons trigger ${id} failed:`, (err as Error).message);
        await progress.update(`❌ ${id} failed: ${(err as Error).message}`);
      }
      return; // void — progress already posted final state
    }

    if (sub === "pause" && id) {
      if (isBuiltinJob(id)) return { text: `⚠️ ${id} is a built-in job and cannot be paused.` };
      await cronScheduler.pauseJob(id);
      return { text: `⏸️ ${id} paused.` };
    }

    if (sub === "resume" && id) {
      if (isBuiltinJob(id)) return { text: `⚠️ ${id} is a built-in job and cannot be resumed.` };
      await cronScheduler.resumeJob(id);
      return { text: `▶️ ${id} resumed.` };
    }

    // Default: list jobs.
    const items = await cronScheduler.listJobs();
    if (items.length === 0) {
      return { text: "No cron jobs configured.\n\nCreate one with:\n`roundhouse cron add <id> --prompt \"...\" --every 6h`" };
    }

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
    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `⚠️ Cron error: ${(err as Error).message}` };
  } finally {
    stopTyping();
    console.log(`[roundhouse] /crons for thread=${thread.id}`);
  }
}

// ── /think ───────────────────────────────────────────

/** Show or set the thinking level of the conversation the command was sent in. */
export async function handleThink(opts: {
  thread: any;
  text: string;
  agentThreadId: string;
  agent: AgentAdapter;
  /** Posts markdown through the transport; a bare thread.post would show the markup literally. */
  postWithFallback: (thread: any, text: string) => Promise<void>;
}): Promise<void> {
  const { thread, text, agentThreadId, agent, postWithFallback: post } = opts;
  if (!agent.thinkingLevel) {
    await post(thread, "⚠️ This agent has no thinking level to set.");
    return;
  }
  const wanted = text.split(/\s+/).slice(1)[0]?.toLowerCase();
  const result = await agent.thinkingLevel(agentThreadId, wanted);
  if (!result) {
    await post(thread, "⚠️ No conversation to set it on yet. Send a message first.");
    return;
  }
  const levels = result.available.join(", ");
  if (!wanted) {
    await post(thread, `🧠 Thinking: *${result.level}*\nAvailable on this model: ${levels}\nUsage: \`/think ${result.available.find((l) => l !== result.level) ?? "high"}\``);
  } else if (result.level === wanted) {
    await post(thread, result.deferred
      ? `✅ Thinking will be *${result.level}* from the next turn of this conversation.`
      : `✅ Thinking set to *${result.level}* for this conversation.`);
  } else {
    await post(thread, `⚠️ \`${wanted}\` is not a level this model has. Thinking stays at *${result.level}*. Available: ${levels}`);
  }
  console.log(`[roundhouse] /think ${wanted ?? ""} for agentThread=${agentThreadId} -> ${result.level}`);
}

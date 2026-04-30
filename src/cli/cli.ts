#!/usr/bin/env node

/**
 * roundhouse CLI entry point
 */

import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { execSync, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONFIG_DIR,
  CONFIG_PATH,
  ENV_FILE_PATH,
  DEFAULT_CONFIG,
  SESSIONS_DIR,
  SERVICE_NAME,
  fileExists,
  loadConfig,
  resolveEnvFilePath,
} from "../config";
import { getAgentSdkPackage } from "../agents/registry";
import { threadIdToDir } from "../util";
import { parseEnvFile, serializeEnvFile, envQuote } from "./env-file";
import {
  SERVICE_PATH,
  systemctl,
  runSudo,
  isServiceInstalled,
  isServiceActive,
  systemctlShow,
  resolveExecStart,
  generateUnit,
  writeServiceUnit,
} from "./systemd";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Shell helpers ───────────────────────────────────

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: opts?.silent ? "pipe" : "inherit" }).trim();
  } catch (e: any) {
    if (opts?.silent) return "";
    throw e;
  }
}

// ── Commands ────────────────────────────────────────

async function cmdStart() {
  if (isServiceInstalled()) {
    if (isServiceActive()) {
      console.log("Roundhouse is already running.");
      console.log("  Use: roundhouse restart   to restart");
      console.log("       roundhouse status    to check status");
      console.log("       roundhouse logs      to tail logs");
      return;
    }
    systemctl("start", "Daemon started.");
    return;
  }

  // No systemd service — fall back to foreground
  console.log("No systemd service found. Running in foreground (use Ctrl+C to stop)...");
  console.log("  Tip: run 'roundhouse install' to set up the systemd daemon.\n");
  await cmdRun();
}

async function cmdRun() {
  process.env.ROUNDHOUSE_CONFIG = CONFIG_PATH;
  const indexPath = resolve(__dirname, "..", "index.ts");
  const jsPath = resolve(__dirname, "..", "dist", "index.js");

  if (await fileExists(jsPath)) {
    await import(jsPath);
  } else {
    const tsxPath = resolve(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    execFileSync(process.execPath, [tsxPath, indexPath], {
      stdio: "inherit",
      env: { ...process.env, ROUNDHOUSE_CONFIG: CONFIG_PATH },
    });
  }
}

async function cmdInstall() {
  console.log("[roundhouse] Installing as systemd daemon...\n");

  await mkdir(CONFIG_DIR, { recursive: true });
  if (await fileExists(CONFIG_PATH)) {
    console.log(`  Config exists: ${CONFIG_PATH}`);
  } else {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log(`  Created config: ${CONFIG_PATH}`);
    console.log(`  ⚠️  Edit this file to set allowedUsers and other settings.`);
  }

  // Write environment file for secrets — merge with existing to preserve manually-added keys
  const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BOT_USERNAME", "ALLOWED_USERS", "NOTIFY_CHAT_IDS", "AWS_PROFILE", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const resolvedEnvPath = await resolveEnvFilePath();
  const existing = await fileExists(resolvedEnvPath)
    ? parseEnvFile(await readFile(resolvedEnvPath, "utf8"))
    : new Map<string, string>();

  // Override with current env vars for known keys
  let envChanged = false;
  for (const key of ENV_KEYS) {
    if (process.env[key]) {
      existing.set(key, envQuote(process.env[key]));
      envChanged = true;
    }
  }
  if (envChanged || !(await fileExists(ENV_FILE_PATH))) {
    if (resolvedEnvPath !== ENV_FILE_PATH && await fileExists(resolvedEnvPath)) {
      console.log(`  Copying env file from ${resolvedEnvPath} to ${ENV_FILE_PATH}`);
    }
    await writeFile(ENV_FILE_PATH, serializeEnvFile(existing), { mode: 0o600 });
    console.log(`  Environment file: ${ENV_FILE_PATH}`);
  }

  // Generate and install systemd unit
  const { execStart, nodeBinDir } = resolveExecStart();
  const unit = generateUnit({ execStart, nodeBinDir });
  await writeServiceUnit(unit);
  systemctl("enable");
  systemctl("start", "Daemon installed and started.");

  console.log(`\n  Config:   ${CONFIG_PATH}`);
  console.log(`  Env file: ${ENV_FILE_PATH}`);
  console.log(`  Service:  ${SERVICE_PATH}`);
  console.log(`  Logs:     roundhouse logs`);
  console.log(`  Status:   roundhouse status`);

  if (!envChanged) {
    console.log(`\n  ⚠️  No env vars detected. Edit ${ENV_FILE_PATH} with your secrets:`);
    console.log(`     TELEGRAM_BOT_TOKEN=...`);
    console.log(`     Then add your API keys and run: roundhouse restart`);
  }
}

async function cmdUninstall() {
  console.log("[roundhouse] Removing systemd daemon...");
  try { systemctl("stop"); } catch {}
  try { systemctl("disable"); } catch {}
  try { runSudo("rm", "-f", SERVICE_PATH); } catch {}
  runSudo("systemctl", "daemon-reload");
  console.log("  ✅ Daemon removed. Config preserved at:", CONFIG_PATH);
}

async function cmdUpdate() {
  console.log("[roundhouse] Updating to latest version...\n");
  run("npm update -g roundhouse");
  console.log("\n[roundhouse] Restarting daemon...");
  try {
    systemctl("restart", "Updated and restarted.");
  } catch {
    console.log("  ⚠️  Daemon not running. Start with: roundhouse install");
  }
}

async function cmdStatus() {
  if (!isServiceActive()) {
    console.log("\n  ❌ Roundhouse is not running.\n");
    console.log("  Install with: roundhouse install");
    console.log("  Or start foreground: roundhouse start\n");
    return;
  }

  // Load config for details
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig();
  } catch {}

  // Gather systemd info
  const pid = systemctlShow("MainPID");
  const activeState = systemctlShow("ActiveState");
  const startedAt = systemctlShow("ActiveEnterTimestamp");

  // Compute uptime
  let uptimeStr = "unknown";
  if (startedAt) {
    const startMs = new Date(startedAt).getTime();
    if (!isNaN(startMs)) {
      const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      if (sec < 3600) uptimeStr = `${Math.floor(sec / 60)}m ${sec % 60}s`;
      else uptimeStr = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    }
  }

  // Memory from PID
  let memStr = "unknown";
  if (pid && pid !== "0" && /^\d+$/.test(pid)) {
    const rssKb = run(`ps -o rss= -p ${pid}`, { silent: true }).trim();
    if (rssKb) {
      const parsed = parseInt(rssKb, 10);
      if (!isNaN(parsed)) memStr = `${(parsed / 1024).toFixed(1)} MB`;
    }
  }

  // Read env file for debug flags
  let debugStream = false;
  const statusEnvPath = await resolveEnvFilePath();
  try {
    const envContent = await readFile(statusEnvPath, "utf8");
    debugStream = envContent.includes("ROUNDHOUSE_DEBUG_STREAM=1") || envContent.includes('ROUNDHOUSE_DEBUG_STREAM="1"');
  } catch {}

  // Read versions
  let roundhouseVersion = "unknown";
  let agentVersion = "unknown";
  try {
    const pkgPath = resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    roundhouseVersion = pkg.version;
  } catch {}

  // Resolve agent SDK version from registry
  const agentPkg = config ? getAgentSdkPackage(config.agent.type) : undefined;
  if (agentPkg) {
    try {
      const agentPkgPath = resolve(__dirname, "..", "..", "node_modules", ...agentPkg.split("/"), "package.json");
      agentVersion = JSON.parse(await readFile(agentPkgPath, "utf8")).version;
    } catch {}
  }

  console.log("\n  🟢 Roundhouse is running\n");
  console.log(`  Version:        v${roundhouseVersion}`);
  console.log(`  State:          ${activeState}`);
  console.log(`  PID:            ${pid}`);
  console.log(`  Uptime:         ${uptimeStr}`);
  console.log(`  Memory:         ${memStr}`);

  if (config) {
    const platforms = Object.keys(config.chat.adapters).join(", ");
    const allowedCount = config.chat.allowedUsers?.length ?? 0;
    console.log(`  Agent:          ${config.agent.type} (v${agentVersion})`);
    console.log(`  Agent CWD:      ${config.agent.cwd ?? process.cwd()}`);
    console.log(`  Platforms:      ${platforms}`);
    console.log(`  Bot:            @${config.chat.botUsername}`);
    console.log(`  Allowed users:  ${allowedCount === 0 ? "all (no allowlist)" : config.chat.allowedUsers!.join(", ")}`);
    console.log(`  Notify chats:   ${config.chat.notifyChatIds?.join(", ") ?? "none"}`);
  }

  console.log(`  Debug stream:   ${debugStream ? "on" : "off"}`);
  console.log(`  Config:         ${CONFIG_PATH}`);
  console.log(`  Env file:       ${statusEnvPath}`);
  console.log();
}

function cmdLogs() {
  const child = spawn("journalctl", ["-u", SERVICE_NAME, "-f", "--no-pager", "-n", "100"], {
    stdio: "inherit",
  });
  child.on("error", () => console.log("Could not read logs. Is the daemon installed?"));
}

function cmdStop() { systemctl("stop", "Daemon stopped."); }
function cmdRestart() { systemctl("restart", "Daemon restarted."); }

async function cmdConfig() {
  console.log(`Config path: ${CONFIG_PATH}\n`);
  if (await fileExists(CONFIG_PATH)) {
    console.log(await readFile(CONFIG_PATH, "utf8"));
  } else {
    console.log("(no config file — defaults will be used)");
  }
}

async function cmdTui() {
  const config = await loadConfig();
  const agentType = config.agent?.type ?? "pi";

  if (agentType !== "pi") {
    console.error(`roundhouse tui: agent type "${agentType}" does not support TUI yet.`);
    process.exit(1);
  }

  const threadArg = process.argv[3];
  const threadId = threadArg || "main";
  const threadDir = threadIdToDir(threadId);
  const threadPath = resolve(SESSIONS_DIR, threadDir);
  let candidates: Array<{ sessionFile: string; mtime: number }> = [];
  try {
    candidates = readdirSync(threadPath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const sessionFile = resolve(threadPath, f);
        return { sessionFile, mtime: statSync(sessionFile).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    console.error(`No session directory found at ${threadPath}.`);
    process.exit(1);
  }

  if (candidates.length === 0) {
    console.error(`No session files found at ${threadPath}.`);
    process.exit(1);
  }

  const selected = candidates[0];

  console.log(`\nOpening: ${selected.sessionFile}\n`);

  const child = spawn("pi", ["--resume", selected.sessionFile], { stdio: "inherit" });
  child.on("error", (err) => {
    console.error((err as any).code === "ENOENT" ? "'pi' not found in PATH." : `Failed: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function printHelp() {
  console.log(`
roundhouse — Multi-platform chat gateway for AI agents

Usage:
  roundhouse <command>

Commands:
  setup               One-command install & configure (also works via npx)
  pair                Pair Telegram account for notifications
  start               Start the gateway daemon
  run                 Run the gateway in foreground
  tui [thread]        Open agent TUI on a gateway session
  install             Install as a systemd daemon (requires sudo)
  uninstall           Remove the systemd daemon
  update              Update from npm + restart daemon
  status              Show daemon status
  logs                Tail daemon logs
  stop                Stop the daemon
  restart             Restart the daemon
  config              Show config path and contents
  agent <message>     Send a message to the agent and print response
                       Options: --thread <id>, --stdin, --timeout <sec>,
                                --no-timeout, --verbose, --ephemeral
  doctor [--fix]       Check system health and configuration
                       Options: --fix, --json, --verbose
  cron <command>       Manage scheduled jobs (add, list, trigger, etc.)

Config:
  ~/.roundhouse/gateway.config.json

Environment:
  TELEGRAM_BOT_TOKEN    Telegram bot token
  ANTHROPIC_API_KEY     API key for pi agent
  ALLOWED_USERS         Comma-separated usernames
`);
}

// ── Main ────────────────────────────────────────────

async function cmdAgent() {
  // Usage: roundhouse agent <message>
  //        roundhouse agent --thread <id> <message>
  //        roundhouse agent --ephemeral <message>
  //        echo "message" | roundhouse agent --stdin
  const args = process.argv.slice(3);
  let threadId = "";
  let messageText = "";
  let useStdin = false;
  let timeoutMs = 120_000;
  let verbose = false;
  let ephemeral = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--thread" && args[i + 1]) {
      threadId = args[++i];
    } else if (args[i] === "--stdin") {
      useStdin = true;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val <= 0) { console.error("--timeout must be a positive number (seconds)"); process.exit(1); }
      timeoutMs = val * 1000;
    } else if (args[i] === "--no-timeout") {
      timeoutMs = 0;
    } else if (args[i] === "--verbose") {
      verbose = true;
    } else if (args[i] === "--ephemeral") {
      ephemeral = true;
    } else if (args[i].startsWith("-")) {
      console.error(`Unknown flag: ${args[i]}`);
      process.exit(1);
    } else {
      messageText = args.slice(i).join(" ");
      break;
    }
  }

  if (useStdin) {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_INPUT = 1024 * 1024; // 1 MB
    for await (const chunk of process.stdin) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_INPUT) {
        console.error(`Input exceeds ${MAX_INPUT / 1024}KB limit. Use a file instead.`);
        process.exit(1);
      }
      chunks.push(chunk);
    }
    // Strip single trailing newline (shell echo adds one)
    let raw = Buffer.concat(chunks).toString("utf8");
    if (raw.endsWith("\n")) raw = raw.slice(0, -1);
    messageText = raw;
  }

  if (!messageText) {
    console.error("Usage: roundhouse agent <message>");
    console.error("       roundhouse agent --thread <id> <message>");
    console.error("       echo \"message\" | roundhouse agent --stdin");
    console.error("       roundhouse agent --timeout 60 <message>");
    console.error("       roundhouse agent --verbose <message>");
    console.error("       roundhouse agent --ephemeral <message>");
    process.exit(1);
  }

  if (threadId && ephemeral) {
    console.error("--thread and --ephemeral cannot be used together");
    process.exit(1);
  }

  // Default: shared main session. --ephemeral restores one-off CLI behavior.
  if (!threadId) {
    threadId = ephemeral
      ? `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : "main";
  }

  // Suppress debug/info logs unless --verbose
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  if (!verbose) {
    console.log = () => {};
    console.warn = () => {};
  }

  let agent: import("../types").AgentAdapter | undefined;
  let aborted = false;

  // Clean abort on SIGINT/SIGTERM
  const handleSignal = async () => {
    if (aborted) return;
    aborted = true;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    try { await agent?.abort?.(threadId); } catch {}
    try { await agent?.dispose(); } catch {}
    process.exit(130);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Timeout race
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = timeoutMs > 0
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          aborted = true;
          try { await agent?.abort?.(threadId); } catch {}
          reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      })
    : null;

  try {
    const config = await loadConfig();
    const { getAgentFactory } = await import("../agents/registry");
    const factory = getAgentFactory(config.agent.type);
    agent = factory(config.agent);

    const runAgent = async () => {
      if (agent!.promptStream) {
        for await (const event of agent!.promptStream(threadId, { text: messageText })) {
          if (event.type === "text_delta") {
            process.stdout.write(event.text);
          }
        }
        process.stdout.write("\n");
      } else {
        const response = await agent!.prompt(threadId, { text: messageText });
        origLog(response.text);
      }
    };

    if (timeoutPromise) {
      await Promise.race([runAgent(), timeoutPromise]);
    } else {
      await runAgent();
    }
  } catch (err: any) {
    console.error = origError;
    console.error(`Error: ${err.message}`);
    process.exit(aborted ? 124 : 1); // 124 = timeout (like coreutils)
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    if (!aborted) await agent?.dispose();
  }
}

import { cmdDoctor } from "./doctor";
import { cmdCron } from "./cron";
import { cmdSetup, cmdPair } from "./setup";

const command = process.argv[2];

const commands: Record<string, () => void | Promise<void>> = {
  setup: () => cmdSetup(process.argv.slice(3)),
  pair: () => cmdPair(process.argv.slice(3)),
  start: cmdStart,
  run: cmdRun,
  install: cmdInstall,
  uninstall: cmdUninstall,
  update: cmdUpdate,
  status: cmdStatus,
  logs: cmdLogs,
  stop: cmdStop,
  restart: cmdRestart,
  config: cmdConfig,
  tui: cmdTui,
  doctor: () => cmdDoctor(process.argv.slice(3)),
  cron: () => cmdCron(process.argv.slice(3)),
  agent: cmdAgent,
};

if (command === "--version" || command === "-v") {
  try {
    const pkg = JSON.parse(
      await readFile(resolve(__dirname, "..", "..", "package.json"), "utf8")
    );
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
} else {
  const fn = command ? commands[command] : undefined;
  if (fn) {
    Promise.resolve(fn()).catch((err) => {
      console.error(`[roundhouse] ${command} failed:`, err);
      process.exit(1);
    });
  } else {
    printHelp();
  }
}

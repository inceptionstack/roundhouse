#!/usr/bin/env node

/**
 * roundhouse CLI entry point
 */

import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { execSync, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performUpdate } from "./update";

import {
  CONFIG_PATH,
  SESSIONS_DIR,
  fileExists,
  loadConfig,
  resolveEnvFilePath,
} from "../config";
import { getAgentSdkPackage } from "../agents/registry";
import { threadIdToDir } from "../util";
import { parseEnvFile, unquoteEnvValue } from "./env-file";
import { getServiceManager } from "./service-manager";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Shell helpers ───────────────────────────────────

/**
 * Shell helper — WARNING: passes `cmd` through the system shell.
 * Only call with trusted/hardcoded strings. Any dynamic segments must be
 * validated (e.g. `/^\d+$/.test(pid)`) before interpolation.
 */
function shellExec(cmd: string, opts?: { silent?: boolean }): string {
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: opts?.silent ? "pipe" : "inherit" });
    return (out ?? "").trim();
  } catch (e: any) {
    if (opts?.silent) return "";
    throw e;
  }
}

// ── Commands ────────────────────────────────────────

async function cmdStart() {
  const svc = getServiceManager();
  const result = await svc.start();

  if (result.message === "no-service") {
    // No service installed — fall back to foreground
    if (!(await fileExists(CONFIG_PATH))) {
      console.error("No config found. Run 'roundhouse setup --telegram' first.");
      process.exit(1);
    }
    console.log("No service found. Running in foreground (use Ctrl+C to stop)...");
    if (process.platform !== "darwin") {
      console.log("  Tip: run 'roundhouse setup --telegram' to install as systemd daemon.\n");
    } else {
      console.log("");
    }
    await cmdRun();
    return;
  }

  console.log(result.message);
  if (result.started && process.platform === "darwin") {
    console.log("  Logs: ~/.roundhouse/logs/roundhouse.log");
  } else if (!result.started) {
    console.log("  Logs: roundhouse logs");
    console.log("  Stop: roundhouse stop");
  }
}

async function cmdRun() {
  // Guard: check config exists before launching gateway
  if (!(await fileExists(CONFIG_PATH))) {
    console.error("No config found. Run 'roundhouse setup --telegram' first.");
    process.exit(1);
  }

  process.env.ROUNDHOUSE_CONFIG = CONFIG_PATH;

  // Load .env file so secrets (TELEGRAM_BOT_TOKEN, etc.) are available
  await loadEnvFile();

  const indexPath = resolve(__dirname, "..", "index.ts");
  const jsPath = resolve(__dirname, "..", "dist", "index.js");

  if (await fileExists(jsPath)) {
    await import(jsPath);
  } else {
    const tsxPath = resolve(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    execFileSync(process.execPath, [tsxPath, indexPath], {
      stdio: "inherit",
      env: {
        ...process.env,
        ROUNDHOUSE_CONFIG: CONFIG_PATH,
        NODE_NO_WARNINGS: "1",
      },
    });
  }
}

/**
 * Load the roundhouse .env file into process.env.
 * Does NOT override existing env vars (explicit env takes precedence).
 */
async function loadEnvFile(): Promise<void> {
  const envPath = await resolveEnvFilePath();
  if (!(await fileExists(envPath))) return;
  try {
    const entries = parseEnvFile(await readFile(envPath, "utf8"));
    for (const [key, raw] of entries) {
      if (!process.env[key]) {
        process.env[key] = unquoteEnvValue(raw);
      }
    }
  } catch (e: any) {
    console.warn(`[roundhouse] warning: failed to load ${envPath}: ${e.message}`);
  }
}

async function cmdInstall() {
  console.log("[roundhouse] 'install' is deprecated — use 'roundhouse setup --telegram' instead.\n");

  if (process.platform === "darwin") {
    console.log("  On macOS:");
    console.log("    1. roundhouse setup --telegram");
    console.log("    2. roundhouse start\n");
    process.exitCode = 1;
    return;
  }

  console.log("  Recommended:");
  console.log("    roundhouse setup --telegram\n");
  console.log("  This sets up config, installs packages, pairs Telegram,");
  console.log("  and installs the systemd service — all in one command.\n");
}

async function cmdUninstall() {
  const svc = getServiceManager();
  const result = await svc.uninstall();
  console.log(`  ✅ ${result.message} Config preserved at:`, CONFIG_PATH);
}

async function cmdUpdate() {
  const progress = { update: async (msg: string) => console.log(msg) };
  const result = await performUpdate(progress);

  if (result.action === "already-latest") {
    console.log(`[roundhouse] Already on latest (v${result.currentVersion})`);
    return;
  }

  if (result.action === "error") {
    console.error(`[roundhouse] Update failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`[roundhouse] Updated to v${result.latestVersion}`);

  const svc = getServiceManager();
  const status = await svc.status();

  if (!status.installed) {
    console.log("\n  ✅ Update complete. Restart with: roundhouse start");
  } else {
    console.log("\n[roundhouse] Restarting service...");
    try {
      const restartResult = await svc.restart();
      console.log(`  ✅ ${restartResult.message}`);
    } catch {
      console.log("  ⚠️  Could not restart. Run: roundhouse start");
    }
  }
}

async function cmdStatus() {
  const svc = getServiceManager();
  const svcStatus = await svc.status();

  if (!svcStatus.running) {
    const icon = svcStatus.installed ? "⚠️" : "❌";
    console.log(`\n  ${icon} ${svcStatus.message}\n`);
    console.log("  Start with: roundhouse start\n");
    return;
  }

  // macOS: simple status
  if (process.platform === "darwin") {
    console.log("\n  ✅ Roundhouse is running (LaunchAgent).\n");
    console.log("  Logs: ~/.roundhouse/logs/roundhouse.log");
    console.log("  Stop: roundhouse stop\n");
    return;
  }

  // Linux: detailed systemd status
  const { systemctlShow } = await import("./systemd");

  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try { config = await loadConfig(); } catch {}

  const pid = systemctlShow("MainPID");
  const activeState = systemctlShow("ActiveState");
  const startedAt = systemctlShow("ActiveEnterTimestamp");

  let uptimeStr = "unknown";
  if (startedAt) {
    const startMs = new Date(startedAt).getTime();
    if (!isNaN(startMs)) {
      const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      if (sec < 3600) uptimeStr = `${Math.floor(sec / 60)}m ${sec % 60}s`;
      else uptimeStr = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    }
  }

  let memStr = "unknown";
  if (pid && pid !== "0" && /^\d+$/.test(pid)) {
    const rssKb = shellExec(`ps -o rss= -p ${pid}`, { silent: true }).trim();
    if (rssKb) {
      const parsed = parseInt(rssKb, 10);
      if (!isNaN(parsed)) memStr = `${(parsed / 1024).toFixed(1)} MB`;
    }
  }

  let debugStream = false;
  const statusEnvPath = await resolveEnvFilePath();
  try {
    const envContent = await readFile(statusEnvPath, "utf8");
    debugStream = envContent.includes("ROUNDHOUSE_DEBUG_STREAM=1") || envContent.includes('ROUNDHOUSE_DEBUG_STREAM="1"');
  } catch {}

  let roundhouseVersion = "unknown";
  let agentVersion = "unknown";
  try {
    const pkgPath = resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    roundhouseVersion = pkg.version;
  } catch {}

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

async function cmdStop() {
  const svc = getServiceManager();
  const result = await svc.stop();
  console.log(result.message);
}

async function cmdRestart() {
  const svc = getServiceManager();
  const result = await svc.restart();
  console.log(result.message);
}

async function cmdLogs() {
  const svc = getServiceManager();
  svc.logs();
}

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


import { cmdDoctor } from "./doctor";
import { cmdAgent } from "./agent-command";
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

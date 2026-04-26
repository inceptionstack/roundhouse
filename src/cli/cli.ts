#!/usr/bin/env node

/**
 * roundhouse CLI entry point
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  SERVICE_NAME,
  fileExists,
  loadConfig,
} from "../config";
import { getAgentSdkPackage } from "../agents/registry";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
const ENV_FILE_PATH = resolve(CONFIG_DIR, "env");

// ── Shell helpers ───────────────────────────────────

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: opts?.silent ? "pipe" : "inherit" }).trim();
  } catch (e: any) {
    if (opts?.silent) return "";
    throw e;
  }
}

function runSudo(cmd: string): void {
  execSync(`sudo ${cmd}`, { stdio: "inherit" });
}

function systemctl(verb: string, message?: string): void {
  runSudo(`systemctl ${verb} ${SERVICE_NAME}`);
  if (message) console.log(`  ✅ ${message}`);
}

// ── Commands ────────────────────────────────────────

async function cmdStart() {
  process.env.ROUNDHOUSE_CONFIG = CONFIG_PATH;
  const indexPath = resolve(__dirname, "..", "index.ts");
  const jsPath = resolve(__dirname, "..", "dist", "index.js");

  if (await fileExists(jsPath)) {
    await import(jsPath);
  } else {
    execSync(
      `node ${resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs")} ${indexPath}`,
      { stdio: "inherit", env: { ...process.env, ROUNDHOUSE_CONFIG: CONFIG_PATH } },
    );
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
  const existing = new Map<string, string>();
  if (await fileExists(ENV_FILE_PATH)) {
    const raw = await readFile(ENV_FILE_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) existing.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  // Override with current env vars for known keys
  let envChanged = false;
  for (const key of ENV_KEYS) {
    if (process.env[key]) {
      existing.set(key, `"${process.env[key].replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$$").replace(/`/g, "\\`").replace(/\n/g, "\\n")}"`);
      envChanged = true;
    }
  }
  if (envChanged || !(await fileExists(ENV_FILE_PATH))) {
    const envFileContent = [...existing.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    await writeFile(ENV_FILE_PATH, envFileContent, { mode: 0o600 });
    console.log(`  Environment file: ${ENV_FILE_PATH}`);
  }

  // Resolve paths — prefer the installed bin, fall back to tsx + source
  const binPath = run("which roundhouse", { silent: true });
  const nodePath = run("which node", { silent: true }) || process.execPath;
  const tsxPath = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  const srcIndex = resolve(__dirname, "..", "index.ts");

  let execStart: string;
  if (binPath) {
    execStart = `${nodePath} ${binPath} start`;
  } else {
    // No global install — use tsx directly
    const tsxBin = run("which tsx", { silent: true }) || tsxPath;
    execStart = `${tsxBin} ${srcIndex}`;
  }

  // Compute PATH that includes node's bin dir (for mise/nvm setups)
  const nodeBinDir = dirname(nodePath);
  const pathValue = `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`;

  const unit = `[Unit]
Description=Roundhouse Chat Gateway
After=network.target

[Service]
Type=simple
User=${process.env.USER || "root"}
WorkingDirectory=${homedir()}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
EnvironmentFile=-${ENV_FILE_PATH}
Environment=ROUNDHOUSE_CONFIG=${CONFIG_PATH}
Environment=NODE_ENV=production
Environment=PATH=${pathValue}

[Install]
WantedBy=multi-user.target
`;

  const tmpDir = await mkdtemp(resolve(tmpdir(), "roundhouse-"));
  const tmpUnit = resolve(tmpDir, `${SERVICE_NAME}.service`);
  await writeFile(tmpUnit, unit, { mode: 0o600 });
  runSudo(`cp ${tmpUnit} ${SERVICE_PATH}`);
  runSudo(`rm -rf -- ${tmpDir}`);
  runSudo("systemctl daemon-reload");
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
  try { runSudo(`rm -f ${SERVICE_PATH}`); } catch {}
  runSudo("systemctl daemon-reload");
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
  // Show systemd status
  const isActive = run(`systemctl is-active ${SERVICE_NAME}`, { silent: true }) === "active";

  if (!isActive) {
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
  const pid = run(`systemctl show -p MainPID --value ${SERVICE_NAME}`, { silent: true });
  const activeState = run(`systemctl show -p ActiveState --value ${SERVICE_NAME}`, { silent: true });
  const startedAt = run(`systemctl show -p ActiveEnterTimestamp --value ${SERVICE_NAME}`, { silent: true });

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
  try {
    const envContent = await readFile(ENV_FILE_PATH, "utf8");
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
  console.log(`  Env file:       ${ENV_FILE_PATH}`);
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

  const sessionsBase = (config.agent as any)?.sessionDir
    ?? resolve(homedir(), ".pi", "agent", "gateway-sessions");

  let threadDirs: string[] = [];
  try {
    threadDirs = readdirSync(sessionsBase)
      .filter((d) => { try { return statSync(resolve(sessionsBase, d)).isDirectory(); } catch { return false; } })
      .sort();
  } catch {
    console.error(`No gateway sessions found at ${sessionsBase}`);
    process.exit(1);
  }

  if (threadDirs.length === 0) {
    console.error("No gateway sessions found. Send a message via Telegram/Slack first.");
    process.exit(1);
  }

  const threadArg = process.argv[3];

  interface SessionCandidate { threadDir: string; sessionFile: string; mtime: number; }

  const candidates: SessionCandidate[] = [];
  for (const dir of threadDirs) {
    if (threadArg && !dir.includes(threadArg)) continue;
    const threadPath = resolve(sessionsBase, dir);
    try {
      for (const f of readdirSync(threadPath).filter((f) => f.endsWith(".jsonl"))) {
        const fullPath = resolve(threadPath, f);
        candidates.push({ threadDir: dir, sessionFile: fullPath, mtime: statSync(fullPath).mtimeMs });
      }
    } catch {}
  }

  if (candidates.length === 0) {
    if (threadArg) {
      console.error(`No sessions found matching "${threadArg}".`);
      console.log("Available threads:");
      for (const d of threadDirs) console.log(`  ${d}`);
    } else {
      console.error("No session files found.");
    }
    process.exit(1);
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  let selected: SessionCandidate;
  const uniqueThreads = [...new Set(candidates.map((c) => c.threadDir))];

  if (uniqueThreads.length === 1 || threadArg) {
    selected = candidates[0];
  } else {
    console.log("Available sessions (most recent first):\n");
    const shown: SessionCandidate[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.threadDir)) continue;
      seen.add(c.threadDir);
      shown.push(c);
    }
    for (let i = 0; i < shown.length; i++) {
      const age = Math.round((Date.now() - shown[i].mtime) / 60000);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      console.log(`  [${i + 1}] ${shown[i].threadDir}  (${ageStr})`);
    }
    console.log();

    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((r) => {
      rl.question("Pick a session [1]: ", (ans) => { rl.close(); r(ans.trim() || "1"); });
    });

    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= shown.length) {
      console.error("Invalid selection.");
      process.exit(1);
    }
    selected = candidates.find((c) => c.threadDir === shown[idx].threadDir)!;
  }

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
  start               Start the gateway (foreground)
  tui [thread]        Open agent TUI on a gateway session
  install             Install as a systemd daemon (requires sudo)
  uninstall           Remove the systemd daemon
  update              Update from npm + restart daemon
  status              Show daemon status
  logs                Tail daemon logs
  stop                Stop the daemon
  restart             Restart the daemon
  config              Show config path and contents

Config:
  ~/.config/roundhouse/gateway.config.json

Environment:
  TELEGRAM_BOT_TOKEN    Telegram bot token
  ANTHROPIC_API_KEY     API key for pi agent
  ALLOWED_USERS         Comma-separated usernames
`);
}

// ── Main ────────────────────────────────────────────

const command = process.argv[2];

const commands: Record<string, () => void | Promise<void>> = {
  start: cmdStart,
  install: cmdInstall,
  uninstall: cmdUninstall,
  update: cmdUpdate,
  status: cmdStatus,
  logs: cmdLogs,
  stop: cmdStop,
  restart: cmdRestart,
  config: cmdConfig,
  tui: cmdTui,
};

const fn = command ? commands[command] : undefined;
if (fn) {
  Promise.resolve(fn()).catch((err) => {
    console.error(`[roundhouse] ${command} failed:`, err);
    process.exit(1);
  });
} else {
  printHelp();
}

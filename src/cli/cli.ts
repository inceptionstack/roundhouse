#!/usr/bin/env node

/**
 * roundhouse CLI entry point
 *
 * Commands:
 *   roundhouse start      — start the gateway (foreground)
 *   roundhouse install    — install as a systemd daemon
 *   roundhouse uninstall  — remove the systemd daemon
 *   roundhouse update     — update to latest version from npm + restart daemon
 *   roundhouse status     — show daemon status
 *   roundhouse logs       — tail daemon logs
 *   roundhouse stop       — stop the daemon
 *   roundhouse restart    — restart the daemon
 *   roundhouse config     — show config path and current config
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVICE_NAME = "roundhouse";
const CONFIG_DIR = resolve(homedir(), ".config", "roundhouse");
const CONFIG_PATH = resolve(CONFIG_DIR, "gateway.config.json");
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

const DEFAULT_CONFIG = {
  agent: {
    type: "pi",
    cwd: homedir(),
  },
  chat: {
    botUsername: "roundhouse_bot",
    allowedUsers: [] as string[],
    adapters: {
      telegram: { mode: "polling" },
    },
  },
};

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ── Commands ────────────────────────────────────────

async function cmdStart() {
  // Import and run the gateway in-process (foreground)
  process.env.ROUNDHOUSE_CONFIG = CONFIG_PATH;
  const indexPath = resolve(__dirname, "..", "src", "index.ts");

  // If running from installed npm package, use compiled JS
  const jsPath = resolve(__dirname, "..", "dist", "index.js");
  if (await fileExists(jsPath)) {
    await import(jsPath);
  } else {
    // Dev mode: use tsx
    const { execSync } = await import("node:child_process");
    execSync(`node ${resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs")} ${indexPath}`, {
      stdio: "inherit",
      env: { ...process.env, ROUNDHOUSE_CONFIG: CONFIG_PATH },
    });
  }
}

async function cmdInstall() {
  console.log("[roundhouse] Installing as systemd daemon...\n");

  // 1. Create config if missing
  await mkdir(CONFIG_DIR, { recursive: true });
  if (await fileExists(CONFIG_PATH)) {
    console.log(`  Config exists: ${CONFIG_PATH}`);
  } else {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log(`  Created config: ${CONFIG_PATH}`);
    console.log(`  ⚠️  Edit this file to set allowedUsers and other settings.`);
  }

  // 2. Find roundhouse binary
  const binPath = run("which roundhouse", { silent: true }) || resolve(__dirname, "cli.ts");
  const nodePath = run("which node", { silent: true }) || process.execPath;

  // 3. Gather env vars for the service (only known safe ones)
  const envLines: string[] = [];
  for (const key of ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BOT_USERNAME", "ALLOWED_USERS"]) {
    if (process.env[key]) {
      envLines.push(`Environment=${key}=${process.env[key]}`);
    }
  }

  // 4. Create systemd unit
  const unit = `[Unit]
Description=Roundhouse Chat Gateway
After=network.target

[Service]
Type=simple
User=${process.env.USER || "root"}
WorkingDirectory=${homedir()}
ExecStart=${nodePath} ${binPath} start
Restart=on-failure
RestartSec=5
${envLines.join("\n")}
Environment=ROUNDHOUSE_CONFIG=${CONFIG_PATH}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;

  const tmpUnit = `/tmp/${SERVICE_NAME}.service`;
  await writeFile(tmpUnit, unit);
  runSudo(`cp ${tmpUnit} ${SERVICE_PATH}`);
  runSudo("systemctl daemon-reload");
  runSudo(`systemctl enable ${SERVICE_NAME}`);
  runSudo(`systemctl start ${SERVICE_NAME}`);

  console.log(`\n  ✅ Daemon installed and started.`);
  console.log(`\n  Config:  ${CONFIG_PATH}`);
  console.log(`  Service: ${SERVICE_PATH}`);
  console.log(`  Logs:    roundhouse logs`);
  console.log(`  Status:  roundhouse status`);

  if (envLines.length === 0) {
    console.log(`\n  ⚠️  No env vars detected. You may need to add TELEGRAM_BOT_TOKEN etc.`);
    console.log(`     Edit ${SERVICE_PATH} or use an EnvironmentFile=`);
  }
}

async function cmdUninstall() {
  console.log("[roundhouse] Removing systemd daemon...");
  try {
    runSudo(`systemctl stop ${SERVICE_NAME}`);
  } catch {}
  try {
    runSudo(`systemctl disable ${SERVICE_NAME}`);
  } catch {}
  try {
    runSudo(`rm -f ${SERVICE_PATH}`);
  } catch {}
  runSudo("systemctl daemon-reload");
  console.log("  ✅ Daemon removed. Config preserved at:", CONFIG_PATH);
}

async function cmdUpdate() {
  console.log("[roundhouse] Updating to latest version...\n");
  run("npm update -g roundhouse");
  console.log("\n[roundhouse] Restarting daemon...");
  try {
    runSudo(`systemctl restart ${SERVICE_NAME}`);
    console.log("  ✅ Updated and restarted.");
  } catch {
    console.log("  ⚠️  Daemon not running. Start with: roundhouse install");
  }
}

function cmdStatus() {
  try {
    run(`systemctl status ${SERVICE_NAME}`);
  } catch {
    console.log("Daemon is not installed. Run: roundhouse install");
  }
}

function cmdLogs() {
  const child = spawn("journalctl", ["-u", SERVICE_NAME, "-f", "--no-pager", "-n", "100"], {
    stdio: "inherit",
  });
  child.on("error", () => {
    console.log("Could not read logs. Is the daemon installed?");
  });
}

function cmdStop() {
  runSudo(`systemctl stop ${SERVICE_NAME}`);
  console.log("  ✅ Daemon stopped.");
}

function cmdRestart() {
  runSudo(`systemctl restart ${SERVICE_NAME}`);
  console.log("  ✅ Daemon restarted.");
}

async function cmdConfig() {
  console.log(`Config path: ${CONFIG_PATH}\n`);
  if (await fileExists(CONFIG_PATH)) {
    const content = await readFile(CONFIG_PATH, "utf8");
    console.log(content);
  } else {
    console.log("(no config file — defaults will be used)");
  }
}

async function cmdTui() {
  // 1. Load config to determine agent type
  let config: any = DEFAULT_CONFIG;
  if (await fileExists(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch {}
  }

  const agentType = config.agent?.type ?? "pi";

  if (agentType !== "pi") {
    console.error(`roundhouse tui: agent type "${agentType}" does not support TUI yet.`);
    console.error("Only \"pi\" is supported currently.");
    process.exit(1);
  }

  // 2. Find gateway sessions
  const sessionsBase = config.agent?.sessionDir ?? resolve(homedir(), ".pi", "agent", "gateway-sessions");
  let threadDirs: string[] = [];
  try {
    const { readdirSync, statSync } = await import("node:fs");
    threadDirs = readdirSync(sessionsBase)
      .filter((d: string) => {
        try {
          return statSync(resolve(sessionsBase, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    console.error(`No gateway sessions found at ${sessionsBase}`);
    console.error("Send a message via Telegram/Slack first to create a session.");
    process.exit(1);
  }

  if (threadDirs.length === 0) {
    console.error("No gateway sessions found. Send a message via Telegram/Slack first.");
    process.exit(1);
  }

  // 3. Find session files in each thread dir, pick the most recent
  const { readdirSync, statSync } = await import("node:fs");
  const threadArg = process.argv[3]; // optional: roundhouse tui <thread>

  interface SessionCandidate {
    threadDir: string;
    sessionFile: string;
    mtime: number;
  }

  const candidates: SessionCandidate[] = [];
  for (const dir of threadDirs) {
    if (threadArg && !dir.includes(threadArg)) continue;
    const threadPath = resolve(sessionsBase, dir);
    try {
      const files = readdirSync(threadPath).filter((f: string) => f.endsWith(".jsonl"));
      for (const f of files) {
        const fullPath = resolve(threadPath, f);
        const st = statSync(fullPath);
        candidates.push({ threadDir: dir, sessionFile: fullPath, mtime: st.mtimeMs });
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

  // Sort by most recently modified
  candidates.sort((a, b) => b.mtime - a.mtime);

  // If multiple threads and no filter, let user pick
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

    // Simple prompt
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Pick a session [1]: ", (ans) => {
        rl.close();
        resolve(ans.trim() || "1");
      });
    });

    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= shown.length) {
      console.error("Invalid selection.");
      process.exit(1);
    }
    // Find most recent session file for the selected thread
    selected = candidates.find((c) => c.threadDir === shown[idx].threadDir)!;
  }

  console.log(`\nOpening: ${selected.sessionFile}\n`);

  // 4. Launch pi --resume <session>
  const piArgs = ["--resume", selected.sessionFile];
  const child = spawn("pi", piArgs, { stdio: "inherit" });

  child.on("error", (err) => {
    if ((err as any).code === "ENOENT") {
      console.error("'pi' not found in PATH. Install pi first.");
    } else {
      console.error("Failed to launch pi:", err.message);
    }
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
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

switch (command) {
  case "start":
    cmdStart();
    break;
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "update":
    cmdUpdate();
    break;
  case "status":
    cmdStatus();
    break;
  case "logs":
    cmdLogs();
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdRestart();
    break;
  case "config":
    cmdConfig();
    break;
  case "tui":
    cmdTui();
    break;
  default:
    printHelp();
    break;
}

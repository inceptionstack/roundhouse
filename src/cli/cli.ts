#!/usr/bin/env node

/**
 * roundhouse CLI entry point
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

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
  const indexPath = resolve(__dirname, "..", "src", "index.ts");
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

  const binPath = run("which roundhouse", { silent: true }) || resolve(__dirname, "cli.ts");
  const nodePath = run("which node", { silent: true }) || process.execPath;

  const envLines: string[] = [];
  for (const key of ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BOT_USERNAME", "ALLOWED_USERS"]) {
    if (process.env[key]) envLines.push(`Environment=${key}=${process.env[key]}`);
  }

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
  systemctl("enable");
  systemctl("start", "Daemon installed and started.");

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

switch (command) {
  case "start": cmdStart(); break;
  case "install": cmdInstall(); break;
  case "uninstall": cmdUninstall(); break;
  case "update": cmdUpdate(); break;
  case "status": cmdStatus(); break;
  case "logs": cmdLogs(); break;
  case "stop": cmdStop(); break;
  case "restart": cmdRestart(); break;
  case "config": cmdConfig(); break;
  case "tui": cmdTui(); break;
  default: printHelp(); break;
}

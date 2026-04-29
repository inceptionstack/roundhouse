/**
 * cli/systemd.ts — Shared systemd service management
 *
 * Generates unit files, resolves ExecStart, and installs/writes services.
 * Used by both `roundhouse install` (cli.ts) and `roundhouse setup` (setup.ts).
 */

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  ROUNDHOUSE_DIR,
  CONFIG_PATH,
  ENV_FILE_PATH,
  SERVICE_NAME,
} from "../config";

const __systemdDir = dirname(fileURLToPath(import.meta.url));

export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

// ── Shell helpers ───────────────────────────────────

function execSilent(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function whichSync(cmd: string): string | null {
  return execSilent(`which ${cmd}`) || null;
}

export function runSudo(...args: string[]): void {
  const result = spawnSync("sudo", ["-n", ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    execFileSync("sudo", args, { stdio: "inherit" });
  }
}

export function systemctl(verb: string, message?: string): void {
  runSudo("systemctl", verb, SERVICE_NAME);
  if (message) console.log(`  ✅ ${message}`);
}

export function hasSudoAccess(): boolean {
  return spawnSync("sudo", ["-n", "true"], { stdio: "pipe" }).status === 0;
}

export function isServiceInstalled(): boolean {
  return execSilent(`systemctl list-unit-files ${SERVICE_NAME}.service`).includes(SERVICE_NAME);
}

export function isServiceActive(): boolean {
  return execSilent(`systemctl is-active ${SERVICE_NAME}`) === "active";
}

// ── ExecStart resolution ────────────────────────────

export interface ExecStartOptions {
  /** Path to psst binary (if using psst for secrets) */
  psstBin?: string | null;
}

/**
 * Resolve the ExecStart command for the systemd unit.
 * Prefers the global `roundhouse` binary; falls back to tsx + cli.ts.
 */
export function resolveExecStart(opts: ExecStartOptions = {}): { execStart: string; nodeBinDir: string } {
  const roundhouseBin = whichSync("roundhouse");
  const nodeBin = whichSync("node") || process.execPath;
  const nodeBinDir = dirname(nodeBin);

  let execStart: string;
  if (roundhouseBin) {
    const base = `${nodeBin} ${roundhouseBin} run`;
    execStart = opts.psstBin ? `${opts.psstBin} run ${base}` : base;
  } else {
    // No global install — run CLI via tsx with 'run' subcommand
    const tsxBin = whichSync("tsx") || resolve(__systemdDir, "..", "..", "node_modules", ".bin", "tsx");
    const cliPath = resolve(__systemdDir, "cli.ts");
    const base = `${tsxBin} ${cliPath} run`;
    execStart = opts.psstBin ? `${opts.psstBin} run ${base}` : base;
  }

  return { execStart, nodeBinDir };
}

// ── Unit file generation ────────────────────────────

export interface UnitOptions {
  execStart: string;
  nodeBinDir: string;
  user?: string;
  envFilePath?: string;
}

/**
 * Generate a systemd unit file string.
 */
export function generateUnit(opts: UnitOptions): string {
  const user = opts.user || process.env.USER || "root";
  const envFilePath = opts.envFilePath || ENV_FILE_PATH;
  const pathValue = `${opts.nodeBinDir}:/usr/local/bin:/usr/bin:/bin`;

  return `[Unit]
Description=Roundhouse Chat Gateway
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${homedir()}
ExecStart=${opts.execStart}
Restart=on-failure
RestartSec=5
EnvironmentFile=-${envFilePath}
Environment=ROUNDHOUSE_CONFIG=${CONFIG_PATH}
Environment=NODE_ENV=production
Environment=PATH=${pathValue}
Environment=HOME=${homedir()}

[Install]
WantedBy=multi-user.target
`;
}

// ── Install service ─────────────────────────────────

/**
 * Write a systemd unit file via sudo and reload the daemon.
 * Uses atomic write-to-tmp + sudo cp pattern.
 */
export async function writeServiceUnit(unitContent: string): Promise<void> {
  const tmpPath = resolve(ROUNDHOUSE_DIR, `roundhouse.service.tmp.${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmpPath, unitContent, { mode: 0o600 });
    execFileSync("sudo", ["-n", "cp", tmpPath, SERVICE_PATH], { stdio: "pipe" });
  } finally {
    try { await unlink(tmpPath); } catch {}
  }
  runSudo("systemctl", "daemon-reload");
}

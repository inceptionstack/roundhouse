/**
 * cli/shell.ts — Shared shell utility functions
 *
 * Platform-agnostic helpers for process execution and binary discovery.
 * Used by systemd.ts, launchd.ts, and cli.ts.
 */

import { execFileSync, spawnSync } from "node:child_process";

/**
 * Synchronously locate a binary on PATH.
 * Returns the absolute path or null if not found.
 */
export function whichSync(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8", stdio: "pipe" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Execute a command silently, returning stdout or empty string on failure.
 * Never throws.
 */
export function execSilent(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

/**
 * Check if passwordless sudo is available.
 */
export function hasSudoAccess(): boolean {
  return spawnSync("sudo", ["-n", "true"], { stdio: "pipe" }).status === 0;
}

/**
 * Run a command with sudo. Falls back to interactive sudo if -n fails.
 */
export function runSudo(...args: string[]): void {
  const result = spawnSync("sudo", ["-n", ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    execFileSync("sudo", args, { stdio: "inherit" });
  }
}

/**
 * cli/doctor/shell.ts — Shell helpers for doctor checks
 */

import { execFile } from "node:child_process";

/** Run a command and return stdout, or null on failure */
export function run(cmd: string, args: string[] = [], timeoutMs = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** Run a command and return stdout even if exit code is non-zero. Returns null only on spawn failure. */
export function runLoose(cmd: string, args: string[] = [], timeoutMs = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (_err, stdout, _stderr) => {
      resolve(stdout?.trim() || null);
    });
  });
}

/** Check if a command exists and return its path or null */
export async function which(cmd: string): Promise<string | null> {
  return run("which", [cmd]);
}

/** Get version from a command (e.g. node --version → "v25.9.0") */
export async function getVersion(cmd: string, flag = "--version"): Promise<string | null> {
  return run(cmd, [flag]);
}

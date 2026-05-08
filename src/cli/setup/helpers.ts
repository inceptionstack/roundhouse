/**
 * cli/setup/helpers.ts — Low-level utilities for setup flows
 *
 * Atomic file writes, safe exec wrappers, and other primitives
 * shared by interactive and headless setup paths.
 */

import { writeFile, rename, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Atomically write JSON to a file (write to tmp, rename).
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Atomically write text to a file (write to tmp, rename).
 */
export async function atomicWriteText(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Execute a command, returning stdout or empty string on failure. Never throws.
 */
export function execSafe(cmd: string, args: string[], opts: { silent?: boolean; input?: string } = {}): string {
  try {
    const result = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: opts.silent ? "pipe" : opts.input ? ["pipe", "pipe", "pipe"] : "pipe",
      input: opts.input,
      timeout: 120_000,
    });
    return result.trim();
  } catch {
    return "";
  }
}

/**
 * Execute a command, throwing a descriptive error on failure.
 */
export function execOrFail(cmd: string, args: string[], label: string): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", timeout: 120_000 }).trim();
  } catch (err: any) {
    throw new Error(`${label}: ${err.stderr?.trim() || err.message}`);
  }
}

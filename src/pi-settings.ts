/**
 * pi-settings.ts — Shared read/write/update primitives for ~/.pi/agent/settings.json
 *
 * Single source of truth for all settings.json mutations in roundhouse.
 * Provides:
 * - Atomic writes (tmp + rename)
 * - Serialised read-modify-write via per-process queue + on-disk lockfile
 * - Idempotent enable/disable helpers for the `packages[]` array
 *
 * All functions throw MalformedPiSettingsError on parse failure — callers
 * decide how to surface it (never silent rebuild).
 */

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";

export const PI_SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");
const LOCK_PATH = resolve(homedir(), ".pi", "agent", ".settings.lock");

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  packages?: string[];
  [k: string]: unknown;
}

/**
 * Typed error for malformed settings.json (bad JSON, non-string packages, etc.).
 * Callers catch this at the boundary and decide how to respond.
 */
export class MalformedPiSettingsError extends Error {
  public readonly path: string;
  constructor(message: string, path: string = PI_SETTINGS_PATH) {
    super(message);
    this.name = "MalformedPiSettingsError";
    this.path = path;
  }
}

/**
 * Read ~/.pi/agent/settings.json.
 * Returns `{}` if the file doesn't exist (ENOENT).
 * Throws MalformedPiSettingsError on invalid JSON.
 */
export async function readPiSettings(): Promise<PiSettings> {
  let raw: string;
  try {
    raw = await readFile(PI_SETTINGS_PATH, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new MalformedPiSettingsError(
        `settings.json is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
      );
    }
    // Validate packages[] if present
    if (parsed.packages !== undefined) {
      if (!Array.isArray(parsed.packages)) {
        throw new MalformedPiSettingsError(
          `settings.json "packages" field is not an array (got ${typeof parsed.packages})`,
        );
      }
      for (const entry of parsed.packages) {
        if (typeof entry !== "string") {
          throw new MalformedPiSettingsError(
            `settings.json "packages" contains non-string entry: ${JSON.stringify(entry)}`,
          );
        }
      }
    }
    return parsed as PiSettings;
  } catch (err) {
    if (err instanceof MalformedPiSettingsError) throw err;
    throw new MalformedPiSettingsError(
      `Failed to parse settings.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Atomic write of settings.json (tmp + rename).
 * Deduplicates packages[] on every write.
 * Creates parent directory if needed.
 */
export async function writePiSettings(settings: PiSettings): Promise<void> {
  // Deduplicate packages
  if (Array.isArray(settings.packages)) {
    settings = { ...settings, packages: [...new Set(settings.packages)] };
  }

  const dir = dirname(PI_SETTINGS_PATH);
  await mkdir(dir, { recursive: true });

  const tmp = `${PI_SETTINGS_PATH}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, PI_SETTINGS_PATH);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

// ── Per-process serialisation queue ──
// Ensures only one RMW cycle is in-flight at a time within this process.
let _queue: Promise<any> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = _queue.then(fn, fn);
  _queue = next.catch(() => {}); // swallow so chain doesn't break
  return next;
}

/**
 * Read-modify-write under per-process queue + on-disk lockfile.
 * Serialises across all writers (toggle, /model, /update, provisioning).
 *
 * Throws MalformedPiSettingsError if the file can't be parsed —
 * the mutator is never called in that case.
 */
export async function updatePiSettings(
  mutator: (s: PiSettings) => PiSettings | Promise<PiSettings>,
): Promise<PiSettings> {
  return enqueue(async () => {
    const dir = dirname(PI_SETTINGS_PATH);
    await mkdir(dir, { recursive: true });

    // Ensure lock directory exists (proper-lockfile needs the target to exist)
    // We lock a separate sentinel file so we don't conflict with the main file's tmp/rename
    const lockDir = dirname(LOCK_PATH);
    await mkdir(lockDir, { recursive: true });
    // Ensure the lock target file exists
    try {
      await writeFile(LOCK_PATH, "", { flag: "wx" });
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(LOCK_PATH, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
        stale: 10_000,
      });

      const current = await readPiSettings();
      const updated = await mutator(current);
      await writePiSettings(updated);
      return updated;
    } finally {
      if (release) {
        try { await release(); } catch {}
      }
    }
  });
}

/**
 * Idempotent: ensure `pkg` is present in packages[].
 * Creates the file if missing. Throws MalformedPiSettingsError on bad JSON.
 */
export async function enablePiPackage(pkg: string): Promise<{ changed: boolean }> {
  let changed = false;
  await updatePiSettings((s) => {
    const pkgs = Array.isArray(s.packages) ? [...s.packages] : [];
    if (pkgs.includes(pkg)) {
      changed = false;
      return s;
    }
    changed = true;
    return { ...s, packages: [...pkgs, pkg] };
  });
  return { changed };
}

/**
 * Idempotent: ensure `pkg` is absent from packages[].
 * If the file doesn't exist, returns { changed: false } (nothing to remove).
 * Throws MalformedPiSettingsError on bad JSON.
 */
export async function disablePiPackage(pkg: string): Promise<{ changed: boolean }> {
  let changed = false;
  await updatePiSettings((s) => {
    const pkgs = Array.isArray(s.packages) ? [...s.packages] : [];
    const idx = pkgs.indexOf(pkg);
    if (idx === -1) {
      changed = false;
      return s;
    }
    changed = true;
    const next = [...pkgs];
    next.splice(idx, 1);
    return { ...s, packages: next };
  });
  return { changed };
}

/**
 * Check if a package is currently enabled in settings.json.
 * Returns false if file missing. Throws MalformedPiSettingsError on bad JSON.
 */
export async function isPiPackageEnabled(pkg: string): Promise<boolean> {
  const settings = await readPiSettings();
  return Array.isArray(settings.packages) && settings.packages.includes(pkg);
}

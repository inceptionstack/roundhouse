/**
 * gateway/code-review-toggle.ts — Read/write pi-hard-no's persistent `enabled` flag.
 *
 * The pi-hard-no extension (v1.3.0+) reads `enabled: boolean` from
 * ~/.pi/.hardno/settings.json on each agent_end. Flipping the value here
 * takes effect on the next agent turn — no session restart needed.
 *
 * File routing (matches pi-hard-no's resolveWritePath):
 *   - If cwd is provided AND <cwd>/.hardno/settings.json exists, write there.
 *   - Otherwise, write to ~/.pi/.hardno/settings.json.
 *
 * Rationale: a project-local .hardno/settings.json takes precedence in
 * pi-hard-no's read path. Writing to global when local exists would silently
 * fail — the user toggles, but pi-hard-no keeps reading the shadowing local
 * file. Matching pi-hard-no's write path eliminates that footgun.
 *
 * Atomic write: tmp + rename; preserves any other fields already in the file.
 * Includes mtime-based retry to handle concurrent writes from pi-hard-no
 * itself (e.g. Alt+R toggle happening at the same moment).
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Default shape when no file exists (pi-hard-no treats missing `enabled` as `true`). */
const DEFAULT_ENABLED = true;
const MAX_WRITE_ATTEMPTS = 3;

export interface ToggleOptions {
  /** Home dir override (defaults to os.homedir()). */
  home?: string;
  /**
   * Optional working directory. When provided, a local .hardno/settings.json
   * at this path takes precedence (both for reading current state and for
   * writing the new one) — matching pi-hard-no's resolution order.
   */
  cwd?: string;
}

export interface ToggleResult {
  /** The new state after the toggle. */
  enabled: boolean;
  /** Whether the settings file existed before the toggle. */
  fileExisted: boolean;
  /** Absolute path we wrote to. */
  settingsPath: string;
  /** True if we wrote to a project-local .hardno/settings.json (not global). */
  wroteLocal: boolean;
}

/** Resolve ~/.pi/.hardno/settings.json for the current user. */
export function resolveGlobalSettingsPath(home = homedir()): string {
  return join(home, ".pi", ".hardno", "settings.json");
}

/**
 * Resolve which settings file the toggle should act on.
 * Local wins when present, matching pi-hard-no's read order.
 */
export function resolveSettingsPath(opts: ToggleOptions = {}): {
  path: string;
  isLocal: boolean;
} {
  const home = opts.home ?? homedir();
  if (opts.cwd) {
    const localPath = join(opts.cwd, ".hardno", "settings.json");
    if (existsSync(localPath)) return { path: localPath, isLocal: true };
  }
  return { path: resolveGlobalSettingsPath(home), isLocal: false };
}

/** Read just the `enabled` field from the effective (local-or-global) file.
 *  Returns null if unreadable / missing / malformed.
 *
 *  Semantics match pi-hard-no's isEnabledFromDisk: if the more-specific
 *  (local) file exists but can't be parsed or lacks `enabled`, we do NOT
 *  fall through to global.
 */
export function readEnabled(opts: ToggleOptions = {}): boolean | null {
  const { path } = resolveSettingsPath(opts);
  if (!existsSync(path)) {
    // If local didn't exist (or no cwd given), we're already at global.
    // If cwd was given and we resolved to global, that's fine — fall through
    // naturally. existsSync==false means no file to read.
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      if (typeof parsed.enabled === "boolean") return parsed.enabled;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Flip the `enabled` flag. If no file exists, starts from the default (true)
 * and flips to false. Preserves all other keys in the file.
 *
 * Atomic: tmp + rename so a partial-file read is impossible.
 * Race-safe: captures mtime at read, checks before rename; on mismatch
 *   (another writer intervened), re-reads and retries up to 3 times.
 * Cleanup: orphan tmp files removed on any write/rename failure.
 *
 * Routing: if cwd is given and <cwd>/.hardno/settings.json exists, flips
 * that file (local wins). Otherwise flips ~/.pi/.hardno/settings.json.
 */
export function toggleEnabled(opts: ToggleOptions = {}): ToggleResult {
  const { path, isLocal } = resolveSettingsPath(opts);
  const dir = dirname(path);

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    let existing: Record<string, unknown> = {};
    let fileExisted = false;
    let current = DEFAULT_ENABLED;
    let readMtime: number | null = null;

    if (existsSync(path)) {
      fileExisted = true;
      try {
        const raw = readFileSync(path, "utf8");
        readMtime = statSync(path).mtimeMs;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
          if (typeof existing.enabled === "boolean") current = existing.enabled;
        }
      } catch {
        /* malformed — start fresh, overwrite */
      }
    }

    const next = !current;
    existing.enabled = next;

    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${attempt}`;
    try {
      writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf8" });

      // Race check: if another writer updated the file between our read and
      // our rename, discard this tmp and retry so we don't clobber their edits.
      if (readMtime !== null && attempt < MAX_WRITE_ATTEMPTS) {
        try {
          const currentMtime = statSync(path).mtimeMs;
          if (currentMtime !== readMtime) {
            try { unlinkSync(tmp); } catch { /* ignore */ }
            continue;
          }
        } catch {
          /* stat failed — fall through to rename */
        }
      }

      renameSync(tmp, path);
      return { enabled: next, fileExisted, settingsPath: path, wroteLocal: isLocal };
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  // Unreachable under normal control flow (loop either returns or throws).
  throw new Error("toggleEnabled: exhausted retries without a successful write");
}

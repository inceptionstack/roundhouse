/**
 * gateway/code-review-toggle.ts — Read/write pi-hard-no's persistent `enabled` flag.
 *
 * The pi-hard-no extension (v1.3.0+) reads `enabled: boolean` from
 * ~/.pi/.hardno/settings.json on each agent_end. Flipping the value here
 * takes effect on the next agent turn — no session restart needed.
 *
 * Atomic write: tmp + rename; preserves any other fields already in the file.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default shape when no file exists (pi-hard-no treats missing `enabled` as `true`). */
const DEFAULT_ENABLED = true;

export interface ToggleResult {
  /** The new state after the toggle. */
  enabled: boolean;
  /** Whether the settings file existed before the toggle. */
  fileExisted: boolean;
  /** Absolute path we wrote to. */
  settingsPath: string;
}

/** Resolve ~/.pi/.hardno/settings.json for the current user. */
export function resolveSettingsPath(home = homedir()): string {
  return join(home, ".pi", ".hardno", "settings.json");
}

/** Read just the `enabled` field. Returns null if unreadable / missing / malformed. */
export function readEnabled(home = homedir()): boolean | null {
  const path = resolveSettingsPath(home);
  if (!existsSync(path)) return null;
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
 * Atomic: tmp + rename so a crash mid-write never leaves a partial file.
 */
export function toggleEnabled(home = homedir()): ToggleResult {
  const path = resolveSettingsPath(home);
  const dir = join(home, ".pi", ".hardno");

  let existing: Record<string, unknown> = {};
  let fileExisted = false;
  let current = DEFAULT_ENABLED;

  if (existsSync(path)) {
    fileExisted = true;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, path);

  return { enabled: next, fileExisted, settingsPath: path };
}

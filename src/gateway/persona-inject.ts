/**
 * gateway/persona-inject.ts — Inject <persona> section into agent prompts
 *
 * Reads user.md and soul.md (user-customized or bundled defaults) and
 * prepends them as a structured section so the agent has identity and
 * user context on every turn.
 *
 * Cached with mtime-based invalidation: stat() on each turn (~0.1ms),
 * only re-reads if files have been modified since last load.
 */

import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR } from "../config";

let cachedPersona: string | null = null;
let lastMtime = 0;

const SOUL_PATH = join(ROUNDHOUSE_DIR, "soul.md");
const USER_PATH = join(ROUNDHOUSE_DIR, "user.md");

function getMaxMtime(): number {
  let max = 0;
  try { max = Math.max(max, statSync(SOUL_PATH).mtimeMs); } catch {}
  try { max = Math.max(max, statSync(USER_PATH).mtimeMs); } catch {}
  return max;
}

function loadFile(filename: string): string {
  const userPath = join(ROUNDHOUSE_DIR, filename);
  const bundledPath = join(dirname(fileURLToPath(import.meta.url)), filename);

  try {
    return readFileSync(userPath, "utf8");
  } catch {
    try {
      return readFileSync(bundledPath, "utf8");
    } catch {
      return "";
    }
  }
}

function buildPersona(): string {
  const soul = loadFile("soul.md").trim();
  const user = loadFile("user.md").trim();

  if (!soul && !user) return "";

  const parts: string[] = [];
  if (soul) parts.push(soul);
  if (user) parts.push(user);
  return parts.join("\n\n---\n\n");
}

/**
 * Load persona files and cache the result.
 * Call at gateway startup to eagerly load.
 */
export function loadPersona(): void {
  cachedPersona = buildPersona();
  lastMtime = getMaxMtime();
}

/**
 * Reload persona from disk. Call after agent edits user.md/soul.md
 * (e.g. from an IPC handler or post-tool-execution hook).
 */
export function reloadPersona(): void {
  cachedPersona = buildPersona();
  lastMtime = getMaxMtime();
}

/**
 * Prepend a <persona> section to the prompt text.
 * Only injects if soul.md or user.md have content.
 * Auto-reloads if files have been modified since last load.
 */
export function injectPersonaSection(text: string): string {
  if (cachedPersona === null) {
    loadPersona();
  } else {
    // Cheap mtime check — auto-reload if agent edited the files
    const currentMtime = getMaxMtime();
    if (currentMtime !== lastMtime) {
      reloadPersona();
    }
  }
  if (!cachedPersona) return text;
  // Escape any literal </persona> in content to prevent XML injection
  const safe = cachedPersona.replace(/<\/persona>/gi, "&lt;/persona&gt;");
  return `<persona>\n${safe}\n</persona>\n\n${text}`;
}

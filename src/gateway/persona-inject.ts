/**
 * gateway/persona-inject.ts — Inject <persona> section into agent prompts
 *
 * Reads user.md and soul.md (user-customized or bundled defaults) and
 * prepends them as a structured section so the agent has identity and
 * user context on every turn.
 *
 * Cached on first load (gateway startup). Call reloadPersona() after
 * the agent edits user.md/soul.md to pick up changes within the same
 * process lifetime. Otherwise changes take effect on next restart.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR } from "../config";

let cachedPersona: string | null = null;

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
}

/**
 * Reload persona from disk. Call after agent edits user.md/soul.md
 * (e.g. from an IPC handler or post-tool-execution hook).
 */
export function reloadPersona(): void {
  cachedPersona = buildPersona();
}

/**
 * Prepend a <persona> section to the prompt text.
 * Only injects if soul.md or user.md have content.
 */
export function injectPersonaSection(text: string): string {
  if (cachedPersona === null) loadPersona();
  if (!cachedPersona) return text;
  return `<persona>\n${cachedPersona}\n</persona>\n\n${text}`;
}

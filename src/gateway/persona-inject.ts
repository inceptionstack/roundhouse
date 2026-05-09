/**
 * gateway/persona-inject.ts — Inject <persona> section into agent prompts
 *
 * Reads user.md and soul.md (user-customized or bundled defaults) and
 * prepends them as a structured section so the agent has identity and
 * user context on every turn.
 *
 * No caching — these files are expected to be updated by the agent
 * during conversations (especially user.md). Files are small (<2KB),
 * so readFileSync on each turn is negligible.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR } from "../config";

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

/**
 * Prepend a <persona> section to the prompt text.
 * Only injects if soul.md or user.md have content.
 */
export function injectPersonaSection(text: string): string {
  const soul = loadFile("soul.md").trim();
  const user = loadFile("user.md").trim();

  if (!soul && !user) return text;

  const parts: string[] = [];
  if (soul) parts.push(soul);
  if (user) parts.push(user);
  const persona = parts.join("\n\n---\n\n");

  return `<persona>\n${persona}\n</persona>\n\n${text}`;
}

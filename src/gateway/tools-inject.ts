/**
 * gateway/tools-inject.ts — Inject <tools> section into agent prompts
 *
 * Reads tools.md (bundled or user-customized) and appends it as a
 * structured section so the agent knows what shell tools are available.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR } from "../config";

let cachedToolsContent: string | null = null;

function loadToolsContent(): string {
  if (cachedToolsContent !== null) return cachedToolsContent;

  // Try user-customized tools.md first, then bundled
  const userPath = join(ROUNDHOUSE_DIR, "tools.md");
  const bundledPath = join(dirname(fileURLToPath(import.meta.url)), "tools.md");

  try {
    cachedToolsContent = readFileSync(userPath, "utf8");
  } catch {
    try {
      cachedToolsContent = readFileSync(bundledPath, "utf8");
    } catch {
      // Don't cache failure — retry next call
      return "";
    }
  }
  return cachedToolsContent;
}

/**
 * Append a <tools> section to the prompt text.
 * Only injects if tools.md has content.
 */
export function injectToolsSection(text: string): string {
  const tools = loadToolsContent();
  if (!tools) return text;
  // Escape any tags that could break the XML structure
  const sanitized = tools.trim().replace(/<\/?tools>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  return `${text}\n\n<tools>\n${sanitized}\n</tools>`;
}

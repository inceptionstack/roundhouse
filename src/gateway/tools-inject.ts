/**
 * gateway/tools-inject.ts — Inject <tools> section into agent prompts
 *
 * Reads tools.md (bundled or user-customized) and appends it as a
 * structured section so the agent knows what shell tools are available.
 */

import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR } from "../config";

let cachedToolsContent: string | null = null;
let cachedToolsMtime = -1;

const USER_TOOLS_PATH = join(ROUNDHOUSE_DIR, "tools.md");
const BUNDLED_TOOLS_PATH = join(dirname(fileURLToPath(import.meta.url)), "tools.md");

/** mtime of the user's tools.md, or 0 when there is none (bundled copy in use). */
function userToolsMtime(): number {
  try { return statSync(USER_TOOLS_PATH).mtimeMs; } catch { return 0; }
}

function loadToolsContent(): string {
  // Reload when the user's tools.md appears, changes or goes away.
  const mtime = userToolsMtime();
  if (cachedToolsContent !== null && mtime === cachedToolsMtime) return cachedToolsContent;

  let content: string;
  try {
    content = readFileSync(USER_TOOLS_PATH, "utf8");
  } catch {
    try {
      content = readFileSync(BUNDLED_TOOLS_PATH, "utf8");
    } catch {
      // Don't cache failure — retry next call
      return "";
    }
  }
  cachedToolsContent = content;
  cachedToolsMtime = mtime;
  return content;
}

/** The <tools> block, or "" when tools.md is empty or missing. */
export function toolsSection(): string {
  const tools = loadToolsContent();
  if (!tools.trim()) return "";
  // Escape any tags that could break the XML structure
  const sanitized = tools.trim().replace(/<\/?tools>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  return `<tools>\n${sanitized}\n</tools>`;
}

/**
 * Append the <tools> section to the prompt text.
 * Only injects if tools.md has content.
 */
export function injectToolsSection(text: string): string {
  const section = toolsSection();
  return section ? `${text}\n\n${section}` : text;
}

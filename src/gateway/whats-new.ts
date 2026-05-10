/**
 * gateway/whats-new.ts — Detect version changes and format "what's new" text
 *
 * On startup, compares current ROUNDHOUSE_VERSION against the last-known
 * version stored in ~/.roundhouse/.last-version. If different, reads the
 * latest CHANGELOG entry and formats it for the startup notification.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDHOUSE_DIR, ROUNDHOUSE_VERSION } from "../config";

const VERSION_FILE = join(ROUNDHOUSE_DIR, ".last-version");

/** Read the bundled CHANGELOG.md and extract the latest version's entry. */
function getLatestChangelog(): string {
  const changelogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md");
  try {
    const content = readFileSync(changelogPath, "utf8");
    // Find first ## [x.y.z] section and extract until next ## or end
    const match = content.match(/^## \[[\d.]+\].*?\n([\s\S]*?)(?=\n## \[|$)/m);
    if (!match) return "";
    // Clean up: take first 5 meaningful lines (skip blank)
    const lines = match[1].trim().split("\n")
      .filter(l => l.trim())
      .slice(0, 6)
      .map(l => l.replace(/^### /, "").replace(/^\*\*/, "• ").replace(/\*\*$/, "").replace(/^- /, "• "));
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Check if version changed since last startup. Returns "what's new" text or null. */
export function checkVersionChange(): string | null {
  let lastVersion = "";
  try {
    lastVersion = readFileSync(VERSION_FILE, "utf8").trim();
  } catch { /* first run or file missing */ }

  // Always update the version file
  try {
    mkdirSync(ROUNDHOUSE_DIR, { recursive: true });
    writeFileSync(VERSION_FILE, ROUNDHOUSE_VERSION + "\n");
  } catch {}

  // No change
  if (lastVersion === ROUNDHOUSE_VERSION) return null;

  // First run (no previous version)
  if (!lastVersion) return null;

  // Version changed — this is an update
  const changelog = getLatestChangelog();
  const header = `🆕 Updated: v${lastVersion} → v${ROUNDHOUSE_VERSION}`;
  if (!changelog) return header;
  return `${header}\n\n${changelog}`;
}

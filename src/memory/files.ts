/**
 * memory/files.ts — Read memory files and compute digests
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { MemoryConfig, MemoryFileSet, MemorySnapshot } from "./types";

const DEFAULTS = {
  mainFile: "MEMORY.md",
  dailyDir: "daily",
  rulesFile: "memory-rules.md",
};

/** Format a date as YYYY-MM-DD */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Get today and recent dates */
function getRecentDates(recentDays: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  dates.push(formatDate(now));
  for (let i = 1; i <= recentDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
  }
  return dates;
}

/** Resolve which memory files to load based on config */
export function resolveMemoryFiles(rootDir: string, config?: MemoryConfig): MemoryFileSet {
  const mainFile = config?.mainFile ?? DEFAULTS.mainFile;
  const dailyDir = config?.dailyDir ?? DEFAULTS.dailyDir;
  const includeToday = config?.inject?.includeToday ?? true;
  const recentDays = config?.inject?.includeRecentDays ?? 1;

  const files: MemoryFileSet["files"] = [];

  // Always include MEMORY.md
  files.push({ label: mainFile, path: resolve(rootDir, mainFile) });

  // Always include memory-rules.md
  files.push({ label: DEFAULTS.rulesFile, path: resolve(rootDir, DEFAULTS.rulesFile) });

  // Daily notes
  if (includeToday) {
    const dates = getRecentDates(recentDays);
    for (const date of dates) {
      const dailyPath = resolve(rootDir, dailyDir, `${date}.md`);
      files.push({ label: `${dailyDir}/${date}.md`, path: dailyPath });
    }
  }

  return { files };
}

/** Read memory files, skip missing ones, return snapshot with digest */
export async function readMemorySnapshot(fileSet: MemoryFileSet, maxBytes?: number): Promise<MemorySnapshot> {
  const entries: MemorySnapshot["entries"] = [];
  let totalBytes = 0;
  const limit = maxBytes ?? 48_000;

  for (const file of fileSet.files) {
    try {
      const content = await readFile(file.path, "utf8");
      if (totalBytes + content.length > limit) {
        // Truncate to fit budget
        const remaining = limit - totalBytes;
        if (remaining > 100) {
          entries.push({ label: file.label, content: content.slice(0, remaining) + "\n\n(truncated)" });
          totalBytes = limit;
        }
        break;
      }
      entries.push({ label: file.label, content });
      totalBytes += content.length;
    } catch {
      // File doesn't exist — skip silently
    }
  }

  const digest = hashEntries(entries);
  return { entries, digest };
}

/** Compute a fast hash of memory entries */
function hashEntries(entries: MemorySnapshot["entries"]): string {
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(e.label);
    h.update("\0");
    h.update(e.content);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * memory/telemetry.ts — Compact-log telemetry helper
 *
 * One source of truth for `compact-timing.jsonl` writes. Lives in `memory/`
 * because the schema models compact lifecycle telemetry, but is consumed
 * by both the memory lifecycle (proactive compaction) and the gateway
 * (reactive overflow recovery, level="gateway-overflow"). Extracting
 * here avoids the cross-domain `gateway → memory/lifecycle` import that
 * the v0.5.38 design doc flagged as a follow-up.
 *
 * Schema is uniform across success/failure (status discriminator) so
 * downstream parsers don't have to handle missing fields.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CompactLogEntry {
  threadId: string;
  level: string;
  effectiveLevel: string;
  flushSkipped: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  flushMs: number;
  compactMs: number;
  totalMs: number;
  model: string;
  status: "ok" | "failed";
  error: string | null;
}

/**
 * Append a compact telemetry entry. Fire-and-forget.
 */
export function appendCompactLog(entry: CompactLogEntry): void {
  const logDir = join(homedir(), ".roundhouse", "logs");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  mkdir(logDir, { recursive: true })
    .then(() => appendFile(join(logDir, "compact-timing.jsonl"), line))
    .catch((err) => console.warn(`[memory] timing log write failed:`, (err as Error).message));
}

/**
 * session-repair.ts — File-level session repair for corrupted pi-ai session files.
 *
 * Pi-ai persists sessions as JSONL at ~/.roundhouse/sessions/<thread>/<id>.jsonl.
 * Each line is a `FileEntry` in a tree (parentId links). Message entries wrap
 * pi-ai `Message` objects (role: user | assistant | toolResult).
 *
 * Corruption scenarios (mid-session):
 *   - Tool execution aborted → toolCall entry written, toolResult never lands
 *   - Process crash between tool completion and result persist
 *   - Manual Ctrl-C mid-tool
 *
 * On next resume, pi-ai loads these entries → sends history to the model →
 * model rejects with "toolUse without toolResult" (Bedrock/Anthropic 400).
 *
 * This module detects and repairs orphaned tool pairs at the file level,
 * preserving the parentId tree by re-parenting children of dropped entries.
 *
 * Delegates tool-pairing logic to message-validator.ts.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { validateToolPairing } from './message-validator.js';
import type { Message, ToolCall, AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

/** Minimal structural type for a pi-ai session file entry (we only touch message entries). */
interface SessionFileEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: Message;
  // other fields preserved as-is
  [key: string]: unknown;
}

export interface SessionRepairReport {
  repaired: boolean;
  droppedEntryIds: string[];
  droppedToolCallIds: string[];
  droppedToolResultIds: string[];
  backupPath?: string;
  totalEntries: number;
}

/** Parse a .jsonl session file. Tolerant of trailing blank lines. Throws on malformed JSON. */
export function parseSessionFile(path: string): SessionFileEntry[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const entries: SessionFileEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionFileEntry);
    } catch (err) {
      throw new Error(`Session file parse error at line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return entries;
}

/**
 * Extract `Message[]` from file entries in the order they appear.
 * Only includes entries of type "message" (skips session header, model_change, etc).
 */
function extractMessages(entries: SessionFileEntry[]): { messages: Message[]; entryIndex: number[] } {
  const messages: Message[] = [];
  const entryIndex: number[] = []; // parallel array: messages[i] came from entries[entryIndex[i]]
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'message' && e.message) {
      messages.push(e.message);
      entryIndex.push(i);
    }
  }
  return { messages, entryIndex };
}

/**
 * Re-parent children of dropped entries to preserve tree validity.
 * If entry X is dropped and entry Y has parentId=X, set Y.parentId = X.parentId.
 */
function reparentDroppedEntries(
  entries: SessionFileEntry[],
  droppedEntryIds: Set<string>
): SessionFileEntry[] {
  // Build a map: droppedId → nearest non-dropped ancestor (walk up the tree)
  const entryById = new Map<string, SessionFileEntry>();
  for (const e of entries) {
    if (e.id) entryById.set(e.id, e);
  }

  const remap = new Map<string, string | null>();
  const resolveAncestor = (id: string, visited: Set<string> = new Set()): string | null => {
    if (remap.has(id)) return remap.get(id)!;
    if (!droppedEntryIds.has(id)) return id;
    if (visited.has(id)) {
      // Cycle in parentId chain (self-parent or loop) — bail with null rather than
      // blow the stack. Should never happen in a well-formed session file.
      remap.set(id, null);
      return null;
    }
    visited.add(id);
    const e = entryById.get(id);
    const parent = e?.parentId ?? null;
    const resolved = parent === null ? null : resolveAncestor(parent, visited);
    remap.set(id, resolved);
    return resolved;
  };

  const kept: SessionFileEntry[] = [];
  for (const e of entries) {
    if (e.id && droppedEntryIds.has(e.id)) continue;
    if (e.parentId && droppedEntryIds.has(e.parentId)) {
      kept.push({ ...e, parentId: resolveAncestor(e.parentId) });
    } else {
      kept.push(e);
    }
  }
  return kept;
}

/**
 * Compute the set of entry IDs to drop based on orphaned tool IDs.
 *
 * - Orphaned toolResult message → drop the whole entry
 * - Orphaned toolCall inside an assistant message → drop the entry only if the
 *   toolCall was the *only* content block (otherwise keep the entry with the
 *   block stripped; handled separately in applyEntryEdits)
 */
function findEntriesToDrop(
  entries: SessionFileEntry[],
  orphanedToolCallIds: Set<string>,
  orphanedToolResultIds: Set<string>
): { entriesToDrop: Set<string>; entriesToEdit: Map<string, string[]> } {
  const entriesToDrop = new Set<string>();
  const entriesToEdit = new Map<string, string[]>(); // entryId → toolCallIds to strip

  for (const e of entries) {
    if (e.type !== 'message' || !e.message || !e.id) continue;
    const msg = e.message;

    if (msg.role === 'toolResult') {
      const tr = msg as ToolResultMessage;
      if (orphanedToolResultIds.has(tr.toolCallId)) {
        entriesToDrop.add(e.id);
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const am = msg as AssistantMessage;
      const orphanCallIds: string[] = [];
      let hasNonOrphanContent = false;
      for (const block of am.content) {
        if ((block as ToolCall).type === 'toolCall') {
          const callId = (block as ToolCall).id;
          if (orphanedToolCallIds.has(callId)) {
            orphanCallIds.push(callId);
          } else {
            hasNonOrphanContent = true;
          }
        } else {
          hasNonOrphanContent = true;
        }
      }
      if (orphanCallIds.length === 0) continue;
      if (hasNonOrphanContent) {
        entriesToEdit.set(e.id, orphanCallIds);
      } else {
        entriesToDrop.add(e.id);
      }
    }
  }

  return { entriesToDrop, entriesToEdit };
}

/** Apply in-place edits to assistant entries: strip orphaned toolCall blocks. */
function applyEntryEdits(
  entries: SessionFileEntry[],
  entriesToEdit: Map<string, string[]>
): SessionFileEntry[] {
  if (entriesToEdit.size === 0) return entries;
  return entries.map(e => {
    if (!e.id || !entriesToEdit.has(e.id)) return e;
    const orphanIds = new Set(entriesToEdit.get(e.id)!);
    const msg = e.message as AssistantMessage;
    const cleanedContent = msg.content.filter(block => {
      if ((block as ToolCall).type === 'toolCall') {
        return !orphanIds.has((block as ToolCall).id);
      }
      return true;
    });
    return { ...e, message: { ...msg, content: cleanedContent } };
  });
}

/** Atomic write: tmp file + rename. Preserves partial-failure safety. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: 'utf8' });
  renameSync(tmp, path);
}

/** Back up the original file before mutation. Returns the backup path. */
function backupFile(path: string): string {
  const ts = Date.now();
  const backupPath = join(dirname(path), `${basename(path)}.bak-${ts}`);
  copyFileSync(path, backupPath);
  return backupPath;
}

/**
 * Validate a session file for orphaned tool pairs without modifying it.
 * Useful for pre-flight checks and tests.
 */
export function inspectSessionFile(path: string): {
  hasOrphans: boolean;
  orphanedToolCallIds: string[];
  orphanedToolResultIds: string[];
  totalEntries: number;
  totalMessages: number;
} {
  const entries = parseSessionFile(path);
  const { messages } = extractMessages(entries);
  const validation = validateToolPairing(messages);
  return {
    hasOrphans: !validation.isValid,
    orphanedToolCallIds: validation.orphanedToolCallIds,
    orphanedToolResultIds: validation.orphanedToolResultIds,
    totalEntries: entries.length,
    totalMessages: messages.length,
  };
}

/**
 * Repair a corrupted session file in place. Creates a .bak-<ts> backup first.
 *
 * Safety:
 * - Backup always written before mutation
 * - Atomic tmp+rename for the repaired file
 * - No-op if no orphans detected (returns repaired: false)
 * - Preserves session tree by re-parenting children of dropped entries
 *
 * @returns report describing what was repaired
 */
/**
 * Pure in-memory tool-pairing repair. Takes entries, returns repaired entries
 * + a report. Does not touch the filesystem. Used directly by
 * `softResetSessionFile` so trim + repair land as a single atomic write, and
 * via a thin wrapper by `repairSessionFile` for on-disk repair.
 */
function repairEntriesInMemory(entries: SessionFileEntry[]): {
  entries: SessionFileEntry[];
  report: SessionRepairReport;
} {
  const { messages } = extractMessages(entries);
  const validation = validateToolPairing(messages);

  if (validation.isValid) {
    return {
      entries,
      report: {
        repaired: false,
        droppedEntryIds: [],
        droppedToolCallIds: [],
        droppedToolResultIds: [],
        totalEntries: entries.length,
      },
    };
  }

  const orphanedCalls = new Set(validation.orphanedToolCallIds);
  const orphanedResults = new Set(validation.orphanedToolResultIds);
  const { entriesToDrop, entriesToEdit } = findEntriesToDrop(entries, orphanedCalls, orphanedResults);
  const edited = applyEntryEdits(entries, entriesToEdit);
  const kept = reparentDroppedEntries(edited, entriesToDrop);

  return {
    entries: kept,
    report: {
      repaired: true,
      droppedEntryIds: Array.from(entriesToDrop),
      droppedToolCallIds: validation.orphanedToolCallIds,
      droppedToolResultIds: validation.orphanedToolResultIds,
      totalEntries: entries.length,
    },
  };
}

export function repairSessionFile(path: string): SessionRepairReport {
  if (!existsSync(path)) {
    throw new Error(`Session file not found: ${path}`);
  }

  const entries = parseSessionFile(path);
  const { entries: repaired, report } = repairEntriesInMemory(entries);

  if (!report.repaired) return report;

  const backupPath = backupFile(path);
  const newContent = repaired.map(e => JSON.stringify(e)).join('\n') + '\n';
  atomicWrite(path, newContent);

  return { ...report, backupPath };
}

// ── Soft reset (recovery from already-overflowed sessions) ──────────────

/**
 * When a session has grown past the model's context window, normal compact
 * cannot recover — the summarizer prompt itself overflows. Soft reset trims
 * the session jsonl on disk to its most-recent N user turns, drops everything
 * older, and re-runs the tool-pairing repair so what's left is internally
 * consistent.
 *
 * Trade-off: loses fidelity for older turns. The roundhouse memory layer
 * (MEMORY.md, daily front-page) re-injects on the next turn, so the agent
 * still has its durable context — just not the verbatim message history.
 *
 * Conservative defaults aim for ~30–40% of a 200k window so the next compact
 * has ample room to summarize.
 */
export interface SoftResetOptions {
  /** Keep at most this many user turns from the tail (default: 8). */
  keepRecentUserTurns?: number;
  /** Hard cap on jsonl bytes after trim (default: 250_000 ≈ 60–80k tokens). */
  maxBytes?: number;
}

export interface SoftResetReport {
  reset: boolean;
  reason: string;
  entriesBefore: number;
  entriesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  backupPath?: string;
  /** Tool-pairing repair report on the trimmed file (orphans created by the cut). */
  postRepair?: SessionRepairReport;
}

/**
 * Find a safe cut index in the entries array. Walk backwards from the end
 * looking for user message entries; the cut sits *at* the Nth most-recent
 * user message we encounter (so the kept tail starts on a user turn).
 * Returns the index of the first entry to KEEP (i.e. all entries[0..cutIdx)
 * are dropped).
 *
 * Byte-cap path: if we exceed the byte budget before reaching N user turns,
 * we still snap the cut to the most-recent user-message boundary we've seen.
 * That guarantees the kept tail always starts with a user message — never an
 * orphaned assistant reply or toolResult whose user prompt was dropped.
 *
 * If we can't find ANY user messages, returns entries.length (drop everything
 * but header) so the caller produces a header-only no-op session rather than
 * a malformed tail.
 */
function findSoftResetCutIndex(
  entries: SessionFileEntry[],
  keepRecentUserTurns: number,
  maxBytes: number,
): { cutIdx: number; reason: string } {
  let userTurnsSeen = 0;
  let bytesAccumulated = 0;
  /** Most recent user-message index we've walked through, or -1 if none yet. */
  let lastUserIdx = -1;
  // Scan tail-to-head, stop when we've collected enough user turns OR exceeded byte budget.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    bytesAccumulated += Buffer.byteLength(JSON.stringify(e), 'utf8') + 1; // +1 for newline
    if (e.type === 'message' && e.message?.role === 'user') {
      userTurnsSeen++;
      lastUserIdx = i;
      if (userTurnsSeen >= keepRecentUserTurns) {
        return { cutIdx: i, reason: `kept-${userTurnsSeen}-user-turns` };
      }
    }
    // Byte cap is a safety net for sessions where a single turn is enormous
    // (e.g. one turn dumped a 200k file). When we hit it we MUST snap the cut
    // to the most recent user-message boundary — otherwise the kept tail could
    // start mid-turn (assistant/toolResult with no user prompt above it), and
    // tool-pairing repair won't fix that.
    if (bytesAccumulated > maxBytes && userTurnsSeen > 0) {
      return { cutIdx: lastUserIdx, reason: `byte-cap-${bytesAccumulated}b` };
    }
  }
  // Fewer user turns than target — treat as no-op. Soft-reset is recovery
  // from overflow; if the session has fewer turns than our target it isn't
  // overflowed and we shouldn't mutate it. Returning 1 means "keep everything
  // after the header", which the caller's `cutIdx <= 1` gate maps to reset:false.
  return { cutIdx: 1, reason: 'fewer-turns-than-target' };
}

/**
 * Soft-reset a pi-ai session jsonl: keep the most-recent N user turns + their
 * surrounding messages, drop everything older. Always preserves the session
 * header (entries[0]). Re-parents the first kept entry to null so the tree
 * remains valid. Re-runs tool-pairing repair on the trimmed file because
 * the cut likely orphaned some toolCall/toolResult pairs.
 *
 * Atomic + backup: same safety pattern as repairSessionFile.
 *
 * @returns report describing what was reset, or `{reset:false}` if nothing to do.
 */
export function softResetSessionFile(
  path: string,
  options: SoftResetOptions = {},
): SoftResetReport {
  if (!existsSync(path)) {
    throw new Error(`Session file not found: ${path}`);
  }

  const keepRecentUserTurns = options.keepRecentUserTurns ?? 8;
  const maxBytes = options.maxBytes ?? 250_000;

  const entries = parseSessionFile(path);
  const bytesBefore = readFileSync(path).length;

  // Need at least header + a couple of messages to be worth resetting.
  if (entries.length < 4) {
    return {
      reset: false,
      reason: 'session-too-small',
      entriesBefore: entries.length,
      entriesAfter: entries.length,
      bytesBefore,
      bytesAfter: bytesBefore,
    };
  }

  const { cutIdx, reason } = findSoftResetCutIndex(entries, keepRecentUserTurns, maxBytes);

  // No-op if cut is already at the start (nothing to drop besides header).
  if (cutIdx <= 1) {
    return {
      reset: false,
      reason: `cut-at-start (${reason})`,
      entriesBefore: entries.length,
      entriesAfter: entries.length,
      bytesBefore,
      bytesAfter: bytesBefore,
    };
  }

  // Build trimmed entries: header + tail.
  // Re-parent the first kept tail entry to null so the tree root is intact.
  const header = entries[0];
  const tail = entries.slice(cutIdx);
  if (tail.length > 0 && tail[0].parentId !== undefined) {
    tail[0] = { ...tail[0], parentId: null };
  }
  const trimmed = [header, ...tail];

  // Run tool-pair repair *in memory* on the trimmed entries before writing,
  // so the on-disk update is a single atomic backup + atomic rename. Doing
  // disk-write → repairSessionFile() (another disk-write) would mean a crash
  // between the two leaves a partially-processed file AND a backup of the
  // already-trimmed file rather than the true original.
  const repaired = repairEntriesInMemory(trimmed);

  const backupPath = backupFile(path);
  const newContent = repaired.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  atomicWrite(path, newContent);

  const bytesAfter = Buffer.byteLength(newContent, 'utf8');
  return {
    reset: true,
    reason,
    entriesBefore: entries.length,
    entriesAfter: repaired.entries.length,
    bytesBefore,
    bytesAfter,
    backupPath,
    postRepair: repaired.report,
  };
}

// ── Error classifiers ────────────────────────────────────────────────────

/**
 * Detect whether an error from pi-ai / the model provider indicates the
 * session has grown past the model's context window (input > max).
 *
 * Triggers soft-reset recovery in the memory lifecycle. Intentionally narrow:
 * only matches the well-known overflow phrasings, not generic 4xx errors.
 *
 * Mirrors `isToolPairingError`'s nested-error handling: provider SDKs commonly
 * wrap the useful text under `cause.message` or in serialized fields on
 * Bedrock ValidationException. Stringify-search is gated on a 4xx / validation
 * shape so we don't false-positive on noisy unrelated errors.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  const patterns = [
    /prompt is too long/i,
    /tokens?\s*[>>]\s*\d+\s*maximum/i,
    /input is too long/i,
    /context length exceeded/i,
    /maximum context length/i,
  ];

  // 1. Top-level message.
  const msg = (err as { message?: string }).message ?? String(err);
  if (patterns.some(p => p.test(msg))) return true;

  // 2. Walk the cause chain (a few hops — don't loop forever on circular).
  let cur: unknown = (err as { cause?: unknown }).cause;
  for (let hop = 0; hop < 5 && cur; hop++) {
    const causeMsg = (cur as { message?: string }).message ?? String(cur);
    if (patterns.some(p => p.test(causeMsg))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }

  // 3. Bedrock ValidationException sometimes carries the overflow text in
  // nested SDK fields. Only stringify-search when the error LOOKS like a 4xx
  // validation error — mirrors the gating in isToolPairingError.
  const name = (err as { name?: string }).name ?? '';
  const httpStatus =
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (name === 'ValidationException' || httpStatus === 400) {
    try {
      const full = JSON.stringify(err);
      if (patterns.some(p => p.test(full))) return true;
    } catch {
      /* circular structure — give up */
    }
  }

  return false;
}

/**
 * Detect whether an error from pi-ai / the model provider indicates a
 * tool-pairing mismatch that can be recovered by session repair.
 *
 * Matches Bedrock Converse and Anthropic error shapes. Intentionally narrow —
 * we don't want to repair on unrelated 400s.
 */
export function isToolPairingError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { message?: string }).message ?? String(err);
  const name = (err as { name?: string }).name ?? '';

  // Bedrock Converse: "messages.N: `tool_use` ids were found without `tool_result` blocks..."
  // Anthropic direct: similar phrasing
  const patterns = [
    /tool_use.*without.*tool_result/i,
    /tool_result.*without.*tool_use/i,
    /toolUse.*without.*toolResult/i,
    /unmatched.*tool.?use/i,
    /orphan.*tool/i,
  ];

  if (patterns.some(p => p.test(msg))) return true;

  // Bedrock ValidationException may carry the pairing text in nested fields
  // (e.g. err.cause.message, $metadata). Only stringify-search when the error
  // *looks* like a Bedrock validation error — avoid noisy matches on unrelated
  // messages that happen to contain '400'.
  const httpStatus =
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (name === 'ValidationException' || httpStatus === 400) {
    try {
      const full = JSON.stringify(err);
      if (patterns.some(p => p.test(full))) return true;
    } catch {
      /* circular structure — give up */
    }
  }
  return false;
}

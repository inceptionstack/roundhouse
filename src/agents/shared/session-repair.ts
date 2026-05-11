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
  const resolveAncestor = (id: string): string | null => {
    if (remap.has(id)) return remap.get(id)!;
    if (!droppedEntryIds.has(id)) return id;
    const e = entryById.get(id);
    const parent = e?.parentId ?? null;
    const resolved = parent === null ? null : resolveAncestor(parent);
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
export function repairSessionFile(path: string): SessionRepairReport {
  if (!existsSync(path)) {
    throw new Error(`Session file not found: ${path}`);
  }

  const entries = parseSessionFile(path);
  const { messages } = extractMessages(entries);
  const validation = validateToolPairing(messages);

  if (validation.isValid) {
    return {
      repaired: false,
      droppedEntryIds: [],
      droppedToolCallIds: [],
      droppedToolResultIds: [],
      totalEntries: entries.length,
    };
  }

  const orphanedCalls = new Set(validation.orphanedToolCallIds);
  const orphanedResults = new Set(validation.orphanedToolResultIds);

  const { entriesToDrop, entriesToEdit } = findEntriesToDrop(entries, orphanedCalls, orphanedResults);
  const edited = applyEntryEdits(entries, entriesToEdit);
  const kept = reparentDroppedEntries(edited, entriesToDrop);

  const backupPath = backupFile(path);
  const newContent = kept.map(e => JSON.stringify(e)).join('\n') + '\n';
  atomicWrite(path, newContent);

  return {
    repaired: true,
    droppedEntryIds: Array.from(entriesToDrop),
    droppedToolCallIds: validation.orphanedToolCallIds,
    droppedToolResultIds: validation.orphanedToolResultIds,
    backupPath,
    totalEntries: entries.length,
  };
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

  // ValidationException from Bedrock with 400 status sometimes carries the text
  // in nested fields; best-effort stringify check.
  if (name === 'ValidationException' || /400/.test(msg)) {
    try {
      const full = JSON.stringify(err);
      if (patterns.some(p => p.test(full))) return true;
    } catch {
      /* circular structure — give up */
    }
  }
  return false;
}

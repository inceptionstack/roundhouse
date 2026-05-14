import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { validateToolPairing } from './message-validator';
import type { Message, ToolCall, AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

/** Minimal structural type for a pi-ai session file entry (we only touch message entries). */
export interface SessionFileEntry {
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

export interface SessionRepairResult {
  entries: SessionFileEntry[];
  report: SessionRepairReport;
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
  const entryIndex: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'message' && entry.message) {
      messages.push(entry.message);
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
  const entryById = new Map<string, SessionFileEntry>();
  for (const entry of entries) {
    if (entry.id) entryById.set(entry.id, entry);
  }

  const remap = new Map<string, string | null>();
  const resolveAncestor = (id: string, visited: Set<string> = new Set()): string | null => {
    if (remap.has(id)) return remap.get(id)!;
    if (!droppedEntryIds.has(id)) return id;
    if (visited.has(id)) {
      remap.set(id, null);
      return null;
    }
    visited.add(id);
    const entry = entryById.get(id);
    const parent = entry?.parentId ?? null;
    const resolved = parent === null ? null : resolveAncestor(parent, visited);
    remap.set(id, resolved);
    return resolved;
  };

  const kept: SessionFileEntry[] = [];
  for (const entry of entries) {
    if (entry.id && droppedEntryIds.has(entry.id)) continue;
    if (entry.parentId && droppedEntryIds.has(entry.parentId)) {
      kept.push({ ...entry, parentId: resolveAncestor(entry.parentId) });
    } else {
      kept.push(entry);
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
  const entriesToEdit = new Map<string, string[]>();

  for (const entry of entries) {
    if (entry.type !== 'message' || !entry.message || !entry.id) continue;
    const message = entry.message;

    if (message.role === 'toolResult') {
      const toolResult = message as ToolResultMessage;
      if (orphanedToolResultIds.has(toolResult.toolCallId)) {
        entriesToDrop.add(entry.id);
      }
      continue;
    }

    if (message.role === 'assistant') {
      const assistantMessage = message as AssistantMessage;
      const orphanCallIds: string[] = [];
      let hasNonOrphanContent = false;
      for (const block of assistantMessage.content) {
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
        entriesToEdit.set(entry.id, orphanCallIds);
      } else {
        entriesToDrop.add(entry.id);
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
  return entries.map(entry => {
    if (!entry.id || !entriesToEdit.has(entry.id)) return entry;
    const orphanIds = new Set(entriesToEdit.get(entry.id)!);
    const message = entry.message as AssistantMessage;
    const cleanedContent = message.content.filter(block => {
      if ((block as ToolCall).type === 'toolCall') {
        return !orphanIds.has((block as ToolCall).id);
      }
      return true;
    });
    return { ...entry, message: { ...message, content: cleanedContent } };
  });
}

/** Atomic write: tmp file + rename. Preserves partial-failure safety. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: 'utf8' });
  renameSync(tmp, path);
}

/** Back up the original file before mutation. Returns the backup path. */
export function backupFile(path: string): string {
  const ts = Date.now();
  const backupPath = join(dirname(path), `${basename(path)}.bak-${ts}`);
  copyFileSync(path, backupPath);
  return backupPath;
}

/**
 * Pure in-memory tool-pairing repair. Takes entries, returns repaired entries
 * + a report. Does not touch the filesystem.
 */
export function repairEntriesInMemory(entries: SessionFileEntry[]): SessionRepairResult {
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

export function assertSessionFileExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Session file not found: ${path}`);
  }
}

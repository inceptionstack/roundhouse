import { readFileSync } from 'node:fs';
import {
  assertSessionFileExists,
  atomicWrite,
  backupFile,
  parseSessionFile,
  repairEntriesInMemory,
  type SessionFileEntry,
  type SessionRepairReport,
} from './session-repair-internal';

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

function findSoftResetCutIndex(
  entries: SessionFileEntry[],
  keepRecentUserTurns: number,
  maxBytes: number,
): { cutIdx: number; reason: string } {
  let userTurnsSeen = 0;
  let bytesAccumulated = 0;
  let lastUserIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    bytesAccumulated += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (entry.type === 'message' && entry.message?.role === 'user') {
      userTurnsSeen++;
      lastUserIdx = i;
      if (userTurnsSeen >= keepRecentUserTurns) {
        return { cutIdx: i, reason: `kept-${userTurnsSeen}-user-turns` };
      }
    }
    if (bytesAccumulated > maxBytes && userTurnsSeen > 0) {
      return { cutIdx: lastUserIdx, reason: `byte-cap-${bytesAccumulated}b` };
    }
  }

  return { cutIdx: 1, reason: 'fewer-turns-than-target' };
}

function buildTrimmedEntries(entries: SessionFileEntry[], cutIdx: number): SessionFileEntry[] {
  const header = entries[0];
  const tail = entries.slice(cutIdx);
  if (tail.length > 0 && tail[0].parentId !== undefined) {
    tail[0] = { ...tail[0], parentId: null };
  }
  return [header, ...tail];
}

export function softResetSessionFile(
  path: string,
  options: SoftResetOptions = {},
): SoftResetReport {
  assertSessionFileExists(path);

  const keepRecentUserTurns = options.keepRecentUserTurns ?? 8;
  const maxBytes = options.maxBytes ?? 250_000;

  const entries = parseSessionFile(path);
  const bytesBefore = readFileSync(path).length;

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

  const trimmed = buildTrimmedEntries(entries, cutIdx);
  const repaired = repairEntriesInMemory(trimmed);

  const backupPath = backupFile(path);
  const newContent = repaired.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
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

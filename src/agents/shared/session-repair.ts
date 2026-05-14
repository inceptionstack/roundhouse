/**
 * session-repair.ts — File-level repair for orphaned toolCall/toolResult pairs.
 */

import { validateToolPairing } from './message-validator';
import {
  assertSessionFileExists,
  atomicWrite,
  backupFile,
  parseSessionFile,
  repairEntriesInMemory,
} from './session-repair-internal';

export { parseSessionFile } from './session-repair-internal';
export type {
  SessionRepairResult,
  SessionFileEntry,
  SessionRepairReport,
} from './session-repair-internal';
export {
  MAX_CAUSE_CHAIN_DEPTH,
  isContextOverflowError,
  isToolPairingError,
  matchesErrorPatterns,
} from './error-classifiers';
export {
  softResetSessionFile,
  type SoftResetOptions,
  type SoftResetReport,
} from './session-soft-reset';

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
  const messages = entries
    .filter(entry => entry.type === 'message' && entry.message)
    .map(entry => entry.message!);
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
export function repairSessionFile(path: string) {
  assertSessionFileExists(path);

  const entries = parseSessionFile(path);
  const { entries: repaired, report } = repairEntriesInMemory(entries);

  if (!report.repaired) return report;

  const backupPath = backupFile(path);
  const newContent = repaired.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  atomicWrite(path, newContent);

  return { ...report, backupPath };
}

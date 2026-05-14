/**
 * session-repair.test.ts — Tests for file-level session repair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseSessionFile,
  inspectSessionFile,
  repairSessionFile,
} from './session-repair';
import { isToolPairingError, isContextOverflowError } from './error-classifiers';
import { softResetSessionFile } from './session-soft-reset';

// ---------- fixtures ----------

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-1',
  timestamp: '2026-05-01T00:00:00Z',
  cwd: '/x',
};

const MODEL_CHANGE = {
  type: 'model_change',
  id: 'mc-1',
  parentId: null,
  timestamp: '2026-05-01T00:00:01Z',
  provider: 'amazon-bedrock',
  modelId: 'us.anthropic.claude-opus-4-7',
};

function userMsg(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-01T00:00:02Z',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
  };
}

function assistantToolCall(id: string, parentId: string | null, toolCallId: string, toolName = 'bash') {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-01T00:00:03Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: {} }],
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      model: 'claude-opus',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 2,
    },
  };
}

function assistantTextAndToolCall(id: string, parentId: string | null, toolCallId: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-01T00:00:03Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'toolCall', id: toolCallId, name: 'bash', arguments: {} },
      ],
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      model: 'claude-opus',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 2,
    },
  };
}

function toolResult(id: string, parentId: string, toolCallId: string, text = 'ok') {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-01T00:00:04Z',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: 3,
    },
  };
}

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- helpers ----------

let tmpFiles: string[] = [];
function tmpJsonl(entries: object[]): string {
  const p = join(tmpdir(), `session-repair-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeJsonl(p, entries);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    if (existsSync(f)) try { unlinkSync(f); } catch { /* ignore */ }
    // clean up any .bak-* files the repair created next to f
    try {
      const dir = f.substring(0, f.lastIndexOf('/'));
      const name = f.substring(f.lastIndexOf('/') + 1);
      for (const sibling of readdirSync(dir)) {
        if (sibling.startsWith(`${name}.bak-`) || sibling.startsWith(`${name}.tmp-`)) {
          try { unlinkSync(join(dir, sibling)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  tmpFiles = [];
});

// ---------- tests ----------

describe('session-repair', () => {
  describe('parseSessionFile', () => {
    it('parses a valid JSONL session', () => {
      const path = tmpJsonl([HEADER, MODEL_CHANGE, userMsg('u1', 'mc-1', 'hi')]);
      const entries = parseSessionFile(path);
      expect(entries.length).toBe(3);
      expect(entries[0].type).toBe('session');
      expect(entries[2].message).toBeDefined();
    });

    it('tolerates trailing blank lines', () => {
      const path = tmpJsonl([HEADER]);
      writeFileSync(path, JSON.stringify(HEADER) + '\n\n\n');
      expect(parseSessionFile(path).length).toBe(1);
    });

    it('throws on malformed JSON with line number', () => {
      const path = join(tmpdir(), `bad-${Date.now()}.jsonl`);
      writeFileSync(path, JSON.stringify(HEADER) + '\n{not json\n');
      tmpFiles.push(path);
      expect(() => parseSessionFile(path)).toThrow(/line 2/);
    });
  });

  describe('inspectSessionFile', () => {
    it('reports clean session as no orphans', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantToolCall('a1', 'u1', 'call-1'),
        toolResult('r1', 'a1', 'call-1'),
      ]);
      const rep = inspectSessionFile(path);
      expect(rep.hasOrphans).toBe(false);
      expect(rep.totalMessages).toBe(3);
    });

    it('detects orphaned toolCall (no result)', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantToolCall('a1', 'u1', 'call-1'),
        // no toolResult — simulates crashed mid-tool
      ]);
      const rep = inspectSessionFile(path);
      expect(rep.hasOrphans).toBe(true);
      expect(rep.orphanedToolCallIds).toEqual(['call-1']);
      expect(rep.orphanedToolResultIds).toEqual([]);
    });

    it('detects orphaned toolResult (no matching call)', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        toolResult('r1', 'u1', 'call-ghost'),
      ]);
      const rep = inspectSessionFile(path);
      expect(rep.hasOrphans).toBe(true);
      expect(rep.orphanedToolResultIds).toEqual(['call-ghost']);
    });
  });

  describe('repairSessionFile', () => {
    it('is a no-op on clean sessions (returns repaired:false, writes no backup)', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantToolCall('a1', 'u1', 'call-1'),
        toolResult('r1', 'a1', 'call-1'),
      ]);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(false);
      expect(rep.backupPath).toBeUndefined();
    });

    it('drops orphaned toolCall-only assistant entry and preserves tree', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantToolCall('a1', 'u1', 'call-1'),  // orphan - no result
        userMsg('u2', 'a1', 'next question'),      // child of dropped entry
      ]);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(true);
      expect(rep.droppedEntryIds).toContain('a1');
      expect(rep.droppedToolCallIds).toEqual(['call-1']);
      expect(rep.backupPath).toBeDefined();

      // Verify tree reparenting: u2's parentId should now be u1 (not a1)
      const repaired = parseSessionFile(path);
      const u2 = repaired.find(e => e.id === 'u2');
      expect(u2?.parentId).toBe('u1');
      // a1 gone
      expect(repaired.find(e => e.id === 'a1')).toBeUndefined();
    });

    it('drops orphaned toolResult entry only, keeps its siblings', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        toolResult('r-ghost', 'u1', 'call-ghost'),
        userMsg('u2', 'r-ghost', 'next'),
      ]);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(true);
      expect(rep.droppedEntryIds).toEqual(['r-ghost']);
      expect(rep.droppedToolResultIds).toEqual(['call-ghost']);

      const repaired = parseSessionFile(path);
      const u2 = repaired.find(e => e.id === 'u2');
      expect(u2?.parentId).toBe('u1'); // reparented
    });

    it('keeps assistant entry but strips orphan toolCall block when text coexists', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantTextAndToolCall('a1', 'u1', 'call-1', 'thinking out loud'),
        // no toolResult for call-1 → orphan, but entry has text too, so KEEP entry + strip block
      ]);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(true);
      expect(rep.droppedEntryIds).not.toContain('a1'); // entry preserved
      expect(rep.droppedToolCallIds).toEqual(['call-1']);

      const repaired = parseSessionFile(path);
      const a1 = repaired.find(e => e.id === 'a1');
      expect(a1).toBeDefined();
      const content = (a1!.message as { content: Array<{ type: string }> }).content;
      expect(content.length).toBe(1);
      expect(content[0].type).toBe('text');
    });

    it('writes backup file before mutation', () => {
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        assistantToolCall('a1', 'u1', 'call-1'),
      ]);
      const before = readFileSync(path, 'utf8');
      const rep = repairSessionFile(path);
      expect(rep.backupPath).toBeDefined();
      expect(existsSync(rep.backupPath!)).toBe(true);
      expect(readFileSync(rep.backupPath!, 'utf8')).toBe(before);
    });

    it('throws on missing file', () => {
      expect(() => repairSessionFile('/nonexistent/path.jsonl')).toThrow(/not found/);
    });
  });

  describe('isToolPairingError', () => {
    it('matches Bedrock tool_use without tool_result', () => {
      const err = new Error('messages.3: `tool_use` ids were found without `tool_result` blocks immediately after');
      expect(isToolPairingError(err)).toBe(true);
    });

    it('matches Anthropic toolUse without toolResult', () => {
      const err = new Error('toolUse id abc123 without matching toolResult');
      expect(isToolPairingError(err)).toBe(true);
    });

    it('matches nested ValidationException', () => {
      const err = Object.assign(new Error('Request failed with status 400'), {
        name: 'ValidationException',
        $metadata: { httpStatusCode: 400 },
        cause: { message: 'messages.0: unmatched tool_use block' },
      });
      expect(isToolPairingError(err)).toBe(true);
    });

    it('matches wrapped Bedrock ValidationException through cause chain', () => {
      const err = new Error('session resume failed', {
        cause: Object.assign(new Error('Request failed with status 400'), {
          name: 'ValidationException',
          $metadata: { httpStatusCode: 400 },
          cause: { message: 'messages.3: `tool_use` ids were found without `tool_result` blocks immediately after' },
        }),
      });
      expect(isToolPairingError(err)).toBe(true);
    });

    it('matches wrapped tool pairing text from a nested cause without stringify fallback', () => {
      const err = new Error('session resume failed', {
        cause: new Error('toolUse id abc123 without matching toolResult'),
      });
      expect(isToolPairingError(err)).toBe(true);
    });

    it('does not match unrelated 400s', () => {
      const err = new Error('Invalid model ID');
      expect(isToolPairingError(err)).toBe(false);
    });

    it('does not match generic messages containing "400" (F5 tightening)', () => {
      // Before the fix, any message containing "400" triggered a JSON.stringify
      // deep search. After fix, we require ValidationException name OR
      // $metadata.httpStatusCode === 400.
      const err = new Error('queued 400 tasks for retry');
      expect(isToolPairingError(err)).toBe(false);
    });

    it('uses $metadata.httpStatusCode to gate deep search (F5)', () => {
      const err = Object.assign(new Error('Bad request'), {
        $metadata: { httpStatusCode: 400 },
        cause: { message: 'tool_use without tool_result in messages.5' },
      });
      expect(isToolPairingError(err)).toBe(true);
    });

    it('handles null/undefined safely', () => {
      expect(isToolPairingError(null)).toBe(false);
      expect(isToolPairingError(undefined)).toBe(false);
    });
  });

  describe('repairSessionFile — tree edge cases', () => {
    it('survives a self-parenting cycle when reparenting a kept child (F3)', () => {
      // Malformed file: orphan assistant entry a1 self-parents (cycle),
      // AND a kept entry u2 points at a1 — forcing reparentDroppedEntries
      // to resolve an ancestor through the cycle. Without the visited guard,
      // this stack-overflows.
      const entries: object[] = [
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        { ...assistantToolCall('a1', 'a1', 'call-1') }, // self-parent orphan
        userMsg('u2', 'a1', 'next'), // kept child pointing into the cycle
      ];
      const path = tmpJsonl(entries);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(true);
      expect(rep.droppedEntryIds).toContain('a1');
      // With the cycle, resolveAncestor bails to null — u2 becomes a root.
      const repaired = parseSessionFile(path);
      const u2 = repaired.find(e => e.id === 'u2');
      expect(u2).toBeDefined();
      expect(u2?.parentId).toBeNull();
    });

    it('survives a 2-node parentId loop when reparenting a kept child (F3)', () => {
      // a1 <-> a2 form a cycle, both orphan toolCalls.
      // u3 is a kept child pointing into the cycle — forces traversal.
      const a1 = assistantToolCall('a1', 'a2', 'call-1');
      const a2 = assistantToolCall('a2', 'a1', 'call-2');
      const path = tmpJsonl([
        HEADER, MODEL_CHANGE,
        userMsg('u1', 'mc-1', 'hi'),
        a1, a2,
        userMsg('u3', 'a2', 'next'), // kept child into the cycle
      ]);
      const rep = repairSessionFile(path);
      expect(rep.repaired).toBe(true);
      expect(rep.droppedEntryIds.sort()).toEqual(['a1', 'a2']);
      // u3 gets reparented to null (cycle bail) rather than crashing.
      const repaired = parseSessionFile(path);
      const u3 = repaired.find(e => e.id === 'u3');
      expect(u3).toBeDefined();
      expect(u3?.parentId).toBeNull();
    });
  });
});

// ============================================================
// softResetSessionFile
// ============================================================

describe('softResetSessionFile', () => {
  function userTurn(idPrefix: string, parentId: string | null) {
    // A user turn = user msg + assistant text reply (no tool calls, so cuts
    // are clean; tool-pairing edge cases are covered by repair tests).
    return [
      userMsg(`${idPrefix}u`, parentId, `text-${idPrefix}`),
      {
        type: 'message',
        id: `${idPrefix}a`,
        parentId: `${idPrefix}u`,
        timestamp: '2026-05-01T00:00:04Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `reply-${idPrefix}` }],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'endTurn',
          timestamp: 4,
        },
      },
    ];
  }

  it('softResetSessionFile_OnSessionWithMoreTurnsThanTarget_KeepsHeaderAndRecentTurns', () => {
    // Arrange: 10 user turns, target keepRecentUserTurns=3.
    const entries: object[] = [HEADER, MODEL_CHANGE];
    let parent: string | null = 'mc-1';
    for (let i = 1; i <= 10; i++) {
      const turn = userTurn(`t${i}`, parent);
      entries.push(...turn);
      parent = `t${i}a`;
    }
    const path = tmpJsonl(entries);

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 3 });

    // Assert: report indicates reset, file shrunk, header preserved, last 3 user msgs present.
    expect(report.reset).toBe(true);
    expect(report.entriesAfter).toBeLessThan(report.entriesBefore);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    expect(report.backupPath).toBeDefined();
    expect(existsSync(report.backupPath!)).toBe(true);

    const trimmed = parseSessionFile(path);
    // Header always preserved.
    expect(trimmed[0].type).toBe('session');
    // Last 3 user turns present.
    const userIds = trimmed.filter(e => e.message?.role === 'user').map(e => e.id);
    expect(userIds).toEqual(['t8u', 't9u', 't10u']);
    // First kept entry's parentId reset to null (no dangling pointer).
    const firstAfterHeader = trimmed[1];
    expect(firstAfterHeader.parentId).toBeNull();
  });

  it('softResetSessionFile_OnSessionSmallerThanTarget_ReturnsResetFalseAndDoesNotMutate', () => {
    // Arrange: 2 user turns, target keepRecentUserTurns=8.
    const entries: object[] = [HEADER, MODEL_CHANGE, ...userTurn('a', 'mc-1'), ...userTurn('b', 'aa')];
    const path = tmpJsonl(entries);
    const before = readFileSync(path, 'utf8');

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 8 });

    // Assert: no reset, file untouched, no backup.
    expect(report.reset).toBe(false);
    expect(report.backupPath).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('softResetSessionFile_OnTinySession_ReturnsResetFalseWithReason', () => {
    // Arrange: only header.
    const path = tmpJsonl([HEADER]);

    // Act
    const report = softResetSessionFile(path);

    // Assert
    expect(report.reset).toBe(false);
    expect(report.reason).toContain('too-small');
  });

  it('softResetSessionFile_OnSessionWithOrphanedToolPairsAfterCut_AlsoRunsRepair', () => {
    // Arrange: a session where the tail contains a toolResult whose toolCall
    // sits in the older (dropped) section. After the cut the toolResult is
    // orphaned — soft-reset must clean it up via the post-cut repair.
    const oldToolCall = assistantToolCall('a-old', 'mc-1', 'call-X');
    const orphanedResult = {
      type: 'message',
      id: 'tr-1',
      parentId: 'a-old',
      timestamp: '2026-05-01T00:00:05Z',
      message: { role: 'toolResult', toolCallId: 'call-X', content: 'ok', timestamp: 5 },
    };
    const entries: object[] = [HEADER, MODEL_CHANGE, userMsg('u-old', 'mc-1', 'old'), oldToolCall];
    let parent: string | null = 'a-old';
    // Push 5 fresh turns so the cut leaves us in tail.
    for (let i = 1; i <= 5; i++) {
      entries.push(...userTurn(`f${i}`, parent));
      parent = `f${i}a`;
    }
    // Insert the orphaned result mid-tail (kept by cut, but call is dropped).
    entries.splice(6, 0, orphanedResult);
    const path = tmpJsonl(entries);

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 3 });

    // Assert: reset succeeded AND post-cut repair fired.
    expect(report.reset).toBe(true);
    expect(report.postRepair).toBeDefined();
    // Final file is internally consistent (no orphans).
    expect(inspectSessionFile(path).hasOrphans).toBe(false);
  });

  it('softResetSessionFile_OnNonexistentFile_Throws', () => {
    // Arrange/Act/Assert: documents the precondition.
    expect(() => softResetSessionFile('/nonexistent/path.jsonl')).toThrow(/not found/);
  });

  it('softResetSessionFile_ByteCapHit_SnapsToUserTurnBoundary_NeverStartsMidTurn', () => {
    // Regression test for codex P1: byte-cap path used to return `i + 1`
    // which could land mid-turn (assistant reply or toolResult with no user
    // prompt above it). Fixed to snap to the most-recent user-message index.
    // Arrange: many small turns, byte cap forces an early cut.
    const entries: object[] = [HEADER, MODEL_CHANGE];
    let parent: string | null = 'mc-1';
    for (let i = 1; i <= 30; i++) {
      entries.push(...userTurn(`t${i}`, parent));
      parent = `t${i}a`;
    }
    const path = tmpJsonl(entries);

    // Act: very tight byte budget so cap fires before keepRecentUserTurns reached.
    const report = softResetSessionFile(path, { keepRecentUserTurns: 100, maxBytes: 600 });

    // Assert: reset happened AND first kept entry is a user message.
    expect(report.reset).toBe(true);
    const trimmed = parseSessionFile(path);
    expect(trimmed[0].type).toBe('session');           // header preserved
    expect(trimmed[1].message?.role).toBe('user');     // first kept = user turn
    expect(trimmed[1].parentId).toBeNull();            // re-parented
  });

  it('softResetSessionFile_NonAsciiContent_ReportedBytesMatchActualFileBytes', () => {
    // Regression test for codex P2: trim used JSON.stringify(e).length
    // (UTF-16 code units) but reported bytesAfter from real file bytes.
    // After fix, both use Buffer.byteLength(..., 'utf8').
    // Arrange: turns containing multi-byte UTF-8 (each emoji = 4 bytes,
    // length 2 in code units — 2x discrepancy).
    const entries: object[] = [HEADER, MODEL_CHANGE];
    const emojis = '🚀🔥🎉✨💡'.repeat(20); // ~100 bytes per turn
    let parent: string | null = 'mc-1';
    for (let i = 1; i <= 20; i++) {
      entries.push(
        userMsg(`t${i}u`, parent, `${emojis} text-${i}`),
        {
          type: 'message', id: `t${i}a`, parentId: `t${i}u`,
          timestamp: '2026-05-01T00:00:04Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${emojis} reply-${i}` }],
            api: 'bedrock-converse-stream', provider: 'amazon-bedrock', model: 'claude',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'endTurn', timestamp: 4,
          },
        },
      );
      parent = `t${i}a`;
    }
    const path = tmpJsonl(entries);

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 100, maxBytes: 2000 });

    // Assert: reported bytesAfter matches actual file bytes (true UTF-8 size).
    expect(report.reset).toBe(true);
    const actualBytes = readFileSync(path).length;
    expect(report.bytesAfter).toBe(actualBytes);
    // And we honored the cap (allow some slack for snap-to-user-boundary).
    expect(report.bytesAfter).toBeLessThan(4000);
  });

  it('softResetSessionFile_OnSingleAtomicWrite_OriginalBackupIsRecoverable', () => {
    // Regression test for codex P2: previously trim wrote once, then
    // repairSessionFile() wrote again with its OWN backup of the
    // already-trimmed file. After fix, only one backup exists and it's
    // the true original.
    // Arrange: session with orphaned tool pair so post-cut repair fires.
    const oldToolCall = assistantToolCall('a-old', 'mc-1', 'call-X');
    const orphanedResult = {
      type: 'message', id: 'tr-1', parentId: 'a-old',
      timestamp: '2026-05-01T00:00:05Z',
      message: { role: 'toolResult', toolCallId: 'call-X', content: 'ok', timestamp: 5 },
    };
    const entries: object[] = [HEADER, MODEL_CHANGE, userMsg('u-old', 'mc-1', 'old'), oldToolCall];
    let parent: string | null = 'a-old';
    for (let i = 1; i <= 5; i++) {
      entries.push(...userTurn(`f${i}`, parent));
      parent = `f${i}a`;
    }
    entries.splice(6, 0, orphanedResult);
    const path = tmpJsonl(entries);
    const originalBytes = readFileSync(path);

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 3 });

    // Assert: backup contents = TRUE original (pre-trim, pre-repair),
    // not an intermediate trimmed-but-unrepaired state.
    expect(report.reset).toBe(true);
    expect(report.backupPath).toBeDefined();
    const backup = readFileSync(report.backupPath!);
    expect(backup.equals(originalBytes)).toBe(true);
    // Final on-disk file is internally consistent.
    expect(inspectSessionFile(path).hasOrphans).toBe(false);
  });

  it('softResetSessionFile_BytesCapHonored_StopsCutAtCap', () => {
    // Arrange: each turn is small but we set a tiny byte cap so we cut early.
    const entries: object[] = [HEADER, MODEL_CHANGE];
    let parent: string | null = 'mc-1';
    for (let i = 1; i <= 20; i++) {
      entries.push(...userTurn(`t${i}`, parent));
      parent = `t${i}a`;
    }
    const path = tmpJsonl(entries);

    // Act
    const report = softResetSessionFile(path, { keepRecentUserTurns: 100, maxBytes: 800 });

    // Assert: reset triggered by byte cap (we asked for 100 turns we don't have,
    // but byte cap kicks in first).
    expect(report.reset).toBe(true);
    expect(report.reason).toMatch(/byte-cap|fewer-turns/);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
  });
});

// ============================================================
// isContextOverflowError
// ============================================================

describe('isContextOverflowError', () => {
  it.each([
    ['prompt is too long: 212776 tokens > 200000 maximum', true],
    ['Validation error: input is too long', true],
    ['context length exceeded for this model', true],
    ['maximum context length reached', true],
    ['tokens > 200000 maximum', true],
    ['toolUse without toolResult', false], // pairing error — different recovery
    ['random network failure', false],
    ['', false],
  ])('classifies %p as overflow=%p', (msg, expected) => {
    expect(isContextOverflowError(new Error(msg))).toBe(expected);
  });

  it('returns false for null/undefined/non-Error inputs', () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError({})).toBe(false);
  });

  it('classifies overflow when text lives in err.cause.message (wrapped SDK error)', () => {
    // Regression test for codex P2: wrapped provider errors used to fall
    // through to re-arming pendingCompact. After fix, cause-chain is walked.
    const inner = new Error('prompt is too long: 212776 tokens > 200000 maximum');
    const outer = new Error('Summarization failed');
    (outer as { cause?: unknown }).cause = inner;
    expect(isContextOverflowError(outer)).toBe(true);
  });

  it('classifies overflow on Bedrock ValidationException with nested overflow text', () => {
    // Regression test: Bedrock SDK can carry the useful text in nested
    // $metadata or stringify-only fields. We only stringify-search when
    // the error LOOKS like a 4xx validation (mirrors isToolPairingError).
    const err = Object.assign(new Error('validation failed'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
      detail: { reason: 'prompt is too long' },
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it('does NOT stringify-search arbitrary errors that contain overflow keywords', () => {
    // Negative case: gating prevents false-positives on unrelated 5xx errors
    // whose payload happens to contain trigger phrases.
    const err = Object.assign(new Error('internal error'), {
      name: 'InternalServerError',
      $metadata: { httpStatusCode: 500 },
      diagnostics: 'log line: prompt is too long check disabled',
    });
    expect(isContextOverflowError(err)).toBe(false);
  });

  it('does not loop forever on circular cause chains', () => {
    // Safety: cause walk is bounded.
    const a = new Error('outer');
    const b = new Error('inner');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a; // cycle
    expect(() => isContextOverflowError(a)).not.toThrow();
    expect(isContextOverflowError(a)).toBe(false);
  });
});

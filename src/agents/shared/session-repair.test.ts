/**
 * session-repair.test.ts — Tests for file-level session repair.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseSessionFile,
  inspectSessionFile,
  repairSessionFile,
  isToolPairingError,
} from './session-repair';

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

    it('does not match unrelated 400s', () => {
      const err = new Error('Invalid model ID');
      expect(isToolPairingError(err)).toBe(false);
    });

    it('handles null/undefined safely', () => {
      expect(isToolPairingError(null)).toBe(false);
      expect(isToolPairingError(undefined)).toBe(false);
    });
  });
});

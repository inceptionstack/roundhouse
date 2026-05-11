/**
 * message-validator.test.ts — Tests for message history validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateToolPairing,
  stripOrphanedResults,
  validateAndRepair,
  type Message,
} from './message-validator';

describe('message-validator', () => {
  describe('validateToolPairing', () => {
    it('passes when all toolCalls and toolResults match', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'help me',
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 3,
        },
      ];

      const result = validateToolPairing(messages);
      expect(result.isValid).toBe(true);
      expect(result.orphanedCount).toBe(0);
      expect(result.orphanedToolCallIds).toEqual([]);
      expect(result.orphanedToolResultIds).toEqual([]);
    });

    it('detects orphaned toolResults (no matching toolCall)', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
        {
          role: 'toolResult', // No matching toolCall!
          toolCallId: 'orphan-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'orphan' }],
          isError: false,
          timestamp: 3,
        },
      ];

      const result = validateToolPairing(messages);
      expect(result.isValid).toBe(false);
      expect(result.orphanedToolResultIds).toContain('orphan-1');
      expect(result.orphanedCount).toBe(1);
    });

    it('detects orphaned toolCalls (no matching toolResult)', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} }, // No result!
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
      ];

      const result = validateToolPairing(messages);
      expect(result.isValid).toBe(false);
      expect(result.orphanedToolCallIds).toContain('call-2');
    });

    it('detects out-of-order: toolResult before toolCall', () => {
      const messages: Message[] = [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'result' }],
          isError: false,
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 2,
        },
      ];

      const result = validateToolPairing(messages);
      expect(result.isValid).toBe(false);
      expect(result.orphanedToolResultIds).toContain('call-1');
    });

    it('handles empty history', () => {
      const result = validateToolPairing([]);
      expect(result.isValid).toBe(true);
      expect(result.orphanedCount).toBe(0);
    });
  });

  describe('stripOrphanedResults', () => {
    it('removes orphaned toolResult messages', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'orphan-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'orphan' }],
          isError: false,
          timestamp: 3,
        },
      ];

      const cleaned = stripOrphanedResults(messages);
      expect(cleaned).toHaveLength(2);
      expect(cleaned).not.toContainEqual(
        expect.objectContaining({ toolCallId: 'orphan-1' })
      );
    });

    it('removes toolCall blocks from assistant messages with orphaned IDs', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'call-2', name: 'read', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
      ];

      const cleaned = stripOrphanedResults(messages);
      expect(cleaned).toHaveLength(2);
      const assistant = cleaned[0] as any;
      expect(assistant.content).toHaveLength(1);
      expect(assistant.content[0].id).toBe('call-1');
    });

    it('removes entire assistant message if all toolCalls are orphaned', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
      ];

      const cleaned = stripOrphanedResults(messages);
      expect(cleaned).toHaveLength(0);
    });

    it('keeps assistant message if it has text content despite orphaned toolCall', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
      ];

      const cleaned = stripOrphanedResults(messages);
      expect(cleaned).toHaveLength(1);
      const assistant = cleaned[0] as any;
      expect(assistant.content).toHaveLength(1);
      expect(assistant.content[0].type).toBe('text');
    });

    it('returns original array if no orphans', () => {
      const messages: Message[] = [
        { role: 'user', content: 'hello', timestamp: 1 },
      ];
      const cleaned = stripOrphanedResults(messages);
      expect(cleaned).toBe(messages); // Same reference
    });
  });

  describe('validateAndRepair', () => {
    it('returns wasRepaired=false for valid history', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
      ];

      const result = validateAndRepair(messages);
      expect(result.wasRepaired).toBe(false);
      expect(result.strippedCount).toBe(0);
      expect(result.messages).toBe(messages);
    });

    it('repairs and reports orphaned calls + results', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'orphan-call', name: 'read', arguments: {} },
          ],
          api: 'bedrock-converse-stream',
          provider: 'amazon-bedrock',
          model: 'claude-opus',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'orphan-result',
          toolName: 'bash',
          content: [{ type: 'text', text: 'orphan' }],
          isError: false,
          timestamp: 3,
        },
      ];

      const result = validateAndRepair(messages);
      expect(result.wasRepaired).toBe(true);
      expect(result.strippedCount).toBe(2);
      expect(result.strippedCallIds).toContain('orphan-call');
      expect(result.strippedResultIds).toContain('orphan-result');
    });
  });
});

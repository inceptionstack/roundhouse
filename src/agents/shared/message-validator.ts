/**
 * message-validator.ts — Validates and repairs agent message history
 *
 * Detects orphaned toolCall/toolResult blocks that corrupt message history:
 * - orphaned toolResults (result without matching call)
 * - orphaned toolCalls (call with no matching result, e.g., aborted tool execution)
 *
 * ⚠️  STATUS: Draft pending integration decision per Codex review.
 * Codex recommends stream-time tool lifecycle tracking (in gateway/streaming.ts)
 * over batch history validation for Pi/Kiro adapters.
 * This module is designed for future raw-history providers.
 */

import type {
  Message,
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

export interface ValidationResult {
  isValid: boolean;
  orphanedToolCallIds: string[];
  orphanedToolResultIds: string[];
  orphanedCount: number;
}

/**
 * Validates that all toolCall/toolResult pairs are complete:
 * - Every toolResult has a matching toolCall earlier in history
 * - Every toolCall has a matching toolResult later in history (in order)
 *
 * Returns both orphaned toolCalls (calls with no result) and orphaned toolResults
 * (results with no matching call).
 */
export function validateToolPairing(messages: Message[]): ValidationResult {
  const toolCallIds = new Set<string>();
  const toolCallIndexes = new Map<string, number>(); // toolCallId -> msgIndex
  const toolResultIds = new Set<string>();
  const orphanedCalls: string[] = [];
  const orphanedResults: string[] = [];

  // First pass: collect all tool call IDs and their positions
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content) {
      for (const block of msg.content) {
        if ((block as ToolCall).type === 'toolCall' && (block as ToolCall).id) {
          const callId = (block as ToolCall).id;
          toolCallIds.add(callId);
          toolCallIndexes.set(callId, i);
        }
      }
    }
  }

  // Second pass: check all toolResult messages have matching toolCall earlier
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'toolResult') {
      const resultMsg = msg as ToolResultMessage;
      toolResultIds.add(resultMsg.toolCallId);

      if (!toolCallIds.has(resultMsg.toolCallId)) {
        orphanedResults.push(resultMsg.toolCallId);
      } else {
        // Verify the toolCall appears before this toolResult
        const callIdx = toolCallIndexes.get(resultMsg.toolCallId);
        if (callIdx !== undefined && callIdx >= i) {
          // Call appears after result (invalid order)
          orphanedResults.push(resultMsg.toolCallId);
        }
      }
    }
  }

  // Third pass: check all toolCalls have matching toolResult later
  for (const [callId, callIdx] of toolCallIndexes.entries()) {
    if (!toolResultIds.has(callId)) {
      // toolCall has no matching toolResult (e.g., execution aborted)
      orphanedCalls.push(callId);
    } else {
      // Verify toolResult appears after this toolCall
      let resultFound = false;
      for (let i = callIdx + 1; i < messages.length; i++) {
        if (messages[i].role === 'toolResult' &&
            (messages[i] as ToolResultMessage).toolCallId === callId) {
          resultFound = true;
          break;
        }
      }
      if (!resultFound) {
        orphanedCalls.push(callId);
      }
    }
  }

  const allOrphaned = orphanedCalls.concat(orphanedResults);
  return {
    isValid: allOrphaned.length === 0,
    orphanedToolCallIds: orphanedCalls,
    orphanedToolResultIds: orphanedResults,
    orphanedCount: allOrphaned.length,
  };
}

/**
 * Strips orphaned toolResults and toolCalls from message history.
 * Returns repaired array or original if no orphans found.
 *
 * - Removes toolResult messages with orphaned IDs
 * - Removes toolCall blocks from assistant messages with orphaned IDs
 * - Strips entire assistant message if it becomes empty after removing toolCalls
 */
export function stripOrphanedResults(messages: Message[]): Message[] {
  const { orphanedToolCallIds, orphanedToolResultIds } = validateToolPairing(messages);
  const idsToRemove = new Set([...orphanedToolCallIds, ...orphanedToolResultIds]);

  if (idsToRemove.size === 0) {
    return messages;
  }

  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      const resultMsg = msg as ToolResultMessage;
      // Skip orphaned toolResult messages
      if (!idsToRemove.has(resultMsg.toolCallId)) {
        result.push(msg);
      }
    } else if (msg.role === 'assistant') {
      const assistantMsg = msg as AssistantMessage;
      // Filter out orphaned toolCall blocks
      const cleanedContent = assistantMsg.content.filter(block => {
        if ((block as ToolCall).type === 'toolCall') {
          return !idsToRemove.has((block as ToolCall).id);
        }
        return true; // Keep text, thinking, images
      });

      // Only keep assistant message if it has remaining content
      if (cleanedContent.length > 0) {
        result.push({
          ...assistantMsg,
          content: cleanedContent,
        });
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}

/**
 * Validates and repairs message history in one call.
 * Returns cleaned messages and a report if any repairs were made.
 */
export interface RepairResult {
  messages: Message[];
  wasRepaired: boolean;
  strippedCount: number;
  strippedCallIds: string[];
  strippedResultIds: string[];
}

export function validateAndRepair(messages: Message[]): RepairResult {
  const validation = validateToolPairing(messages);

  if (validation.isValid) {
    return {
      messages,
      wasRepaired: false,
      strippedCount: 0,
      strippedCallIds: [],
      strippedResultIds: [],
    };
  }

  const cleaned = stripOrphanedResults(messages);

  return {
    messages: cleaned,
    wasRepaired: true,
    strippedCount: validation.orphanedCount,
    strippedCallIds: validation.orphanedToolCallIds,
    strippedResultIds: validation.orphanedToolResultIds,
  };
}

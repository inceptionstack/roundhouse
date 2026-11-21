/**
 * memory/inject.ts — Build memory injection blocks for agent messages
 */

import type { MemorySnapshot } from "./types";
import type { AgentMessage } from "../types";

/**
 * Build a memory injection text block from a snapshot.
 * Includes version/date so the agent knows it supersedes prior blocks.
 */
export function buildMemoryInjection(snapshot: MemorySnapshot, reason: string): string {
  if (snapshot.entries.length === 0) return "";

  const date = new Date().toISOString().slice(0, 19) + "Z";
  // Memory files are written by the agent, partly from things it read. Keep
  // their text from closing the block early and posing as what follows it.
  const escapeTag = (s: string) =>
    s.replace(/<\/?roundhouse_memory\b[^>]*>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  const sections = snapshot.entries.map(
    (e) => `## ${e.label}\n${escapeTag(e.content)}`
  ).join("\n\n");

  return [
    `<roundhouse_memory v="${snapshot.digest}" date="${date}" reason="${reason}">`,
    `This is your current workspace memory. It supersedes any prior roundhouse_memory blocks.`,
    ``,
    sections,
    `</roundhouse_memory>`,
  ].join("\n");
}

/**
 * Prepend memory injection to a user message.
 * Returns a new AgentMessage with memory block + original text.
 */
export function injectMemoryIntoMessage(message: AgentMessage, injection: string): AgentMessage {
  if (!injection) return message;

  const combinedText = message.text
    ? `${injection}\n\n${message.text}`
    : injection;

  return { ...message, text: combinedText };
}

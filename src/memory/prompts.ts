/**
 * memory/prompts.ts — Memory flush prompts for maintenance turns
 */

import type { MemoryMode } from "./types";

/**
 * Build a memory flush prompt based on mode and urgency.
 */
export function buildFlushPrompt(mode: MemoryMode, level: "soft" | "hard" | "emergency"): string {
  const urgency = level === "emergency"
    ? "URGENT: Context is nearly full. "
    : level === "hard"
      ? "Context is filling up. "
      : "";

  if (mode === "complement") {
    // Agent has its own memory extension — only ask for narrative context
    return [
      `Roundhouse maintenance: ${urgency}Before context compaction, save important narrative context:`,
      ``,
      `- Project decisions, architecture choices, investigation status → ~/MEMORY.md`,
      `- Today's notable events, open loops, task progress → today's daily note`,
      ``,
      `Do NOT save individual preferences or corrections — your memory extension handles those automatically.`,
      `Only write facts worth preserving. Do not summarize the whole conversation.`,
      `When done, reply with a one-line confirmation of what you saved.`,
    ].join("\n");
  }

  // Full mode — agent has no memory extension, save everything
  return [
    `Roundhouse maintenance: ${urgency}Before context compaction, update your durable memory files:`,
    ``,
    `- User preferences, project conventions, stable facts → ~/MEMORY.md`,
    `- Today's notable events, decisions, open loops → today's daily note`,
    `- Corrections or lessons learned → ~/MEMORY.md`,
    ``,
    `Only write facts worth preserving. Do not summarize the whole conversation.`,
    `When done, reply with a one-line confirmation of what you saved.`,
  ].join("\n");
}

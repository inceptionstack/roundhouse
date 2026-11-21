/**
 * gateway/standing-context.ts — what the agent is told on every turn
 *
 * The persona (soul.md, user.md) and the host's tool notes (tools.md) do not
 * change from one message to the next. An agent adapter that can carry them
 * in its system prompt takes this text once per session; the gateway then
 * stops repeating it in front of every user message, where it cost about a
 * thousand tokens of context per message and was summarized away by each
 * compaction.
 */

import { personaSection } from "./persona-inject";
import { toolsSection } from "./tools-inject";

/** Persona and tools blocks joined, or "" when both are empty. Re-reads edited files. */
export function buildStandingContext(): string {
  return [personaSection(), toolsSection()].filter(Boolean).join("\n\n");
}

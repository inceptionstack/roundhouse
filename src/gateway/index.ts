/**
 * gateway/index.ts — Barrel export for gateway sub-modules
 *
 * Re-exports helpers, attachments, streaming, and commands for
 * external consumers. The Gateway class itself lives at src/gateway.ts
 * and is imported directly (not through this barrel).
 */

export { isCommand, isCommandWithArgs, resolveAgentThreadId, getSystemResources, toolIcon } from "./helpers";
export { saveAttachments } from "./attachments";
export { handleStreaming } from "./streaming";

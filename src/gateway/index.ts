/**
 * gateway/index.ts — Barrel export for gateway module
 */

export { Gateway } from "./gateway";
export { isCommand, isCommandWithArgs, resolveAgentThreadId, getSystemResources, toolIcon } from "./helpers";
export { saveAttachments } from "./attachments";
export { handleStreaming } from "./streaming";

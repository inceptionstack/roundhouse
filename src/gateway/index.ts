/**
 * gateway/index.ts — Barrel export for gateway sub-modules
 *
 * Re-exports the Gateway class from the main gateway file.
 * Sub-modules (helpers, attachments, streaming) are imported
 * directly by gateway.ts — this barrel is for external consumers.
 */

export { Gateway } from "./gateway";

/**
 * kiro/acp/index.ts — Barrel export for ACP module
 */

export { AcpClient } from "./client.js";
export { spawnKiroCli, shutdownProcess, getKiroCliVersion } from "./process.js";
export type { AcpProcess, SpawnOptions } from "./process.js";
export type * from "./types.js";

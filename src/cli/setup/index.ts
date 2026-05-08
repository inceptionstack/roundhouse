/**
 * cli/setup/index.ts — Barrel export for setup module
 *
 * Re-exports public API from setup sub-modules.
 * Helpers are imported directly by setup.ts.
 */

export { atomicWriteJson, atomicWriteText, execSafe, execOrFail } from "./helpers";

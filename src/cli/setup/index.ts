/**
 * cli/setup/index.ts — Barrel export for setup module
 */

export { atomicWriteJson, atomicWriteText, execSafe, execOrFail } from "./helpers";
export { type SetupOptions, type StepStatus, PI_SETTINGS_PATH, DEFAULT_PROVIDER, DEFAULT_MODEL, EXTENSION_NAME_RE } from "./types";
export { parseSetupArgs } from "./args";

/**
 * cron/helpers.ts — Shared cron helpers to eliminate cross-module duplication
 */

/** Built-in job ID prefix */
export const BUILTIN_JOB_PREFIX = "builtin-";

/** Built-in heartbeat job ID */
export const BUILTIN_HEARTBEAT_JOB_ID = `${BUILTIN_JOB_PREFIX}heartbeat`;

/** Heartbeat file name */
export const HEARTBEAT_FILE_NAME = "HEARTBEAT.md";

/** Check if a job ID is a built-in job */
export function isBuiltinJob(id: string): boolean {
  return id.startsWith(BUILTIN_JOB_PREFIX);
}

/** Build a cron thread ID */
export function buildCronThreadId(jobId: string, runId: string): string {
  return `cron:${jobId}:${runId}`;
}

/** Check if a notify policy should send for a given status */
export function shouldNotify(policy: string | undefined, status: string): boolean {
  if (!policy || policy === "always") return true;
  if (policy === "success" && status === "completed") return true;
  if (policy === "failure" && status !== "completed") return true;
  return false;
}

/**
 * cron/format.ts — Shared cron formatting utilities
 *
 * Used by CLI, gateway /crons, and notifications.
 */

import type { CronSchedule, CronJobConfig, CronJobState, CronRunRecord, CronRunStatus } from "./types";
import { DEFAULT_TIMEOUT_MS } from "./constants";
import { formatDuration } from "./durations";

/** Format a schedule for display */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.type) {
    case "cron": return `${schedule.cron} (${schedule.tz})`;
    case "interval": return `every ${schedule.every}`;
    case "once": return `once at ${schedule.at}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default: return "unknown";
  }
}

/** Icon for job enabled/paused state */
export function jobEnabledIcon(enabled: boolean): string {
  return enabled ? "✅" : "⏸️";
}

/** Icon for run status */
export function runStatusIcon(status: CronRunStatus): string {
  return status === "completed" ? "✅" : "❌";
}

/** Format run count summary */
export function formatRunCounts(state: CronJobState): string {
  return `${state.totalRuns} runs (${state.totalSuccesses}✓ ${state.totalFailures}✗)`;
}

/** Format a single run line */
export function formatRunLine(run: CronRunRecord): string {
  return `${runStatusIcon(run.status)} ${run.id} ${run.status} ${run.durationMs}ms`;
}

/** Format a job summary line */
export function formatJobSummary(job: CronJobConfig, state: CronJobState): string {
  return `${jobEnabledIcon(job.enabled)} ${job.id}: ${formatSchedule(job.schedule)} — ${formatRunCounts(state)}`;
}

/** Format job detail (for show command) */
export function formatJobDetail(job: CronJobConfig, state: CronJobState, runs: CronRunRecord[]): string {
  const lines: string[] = [];
  lines.push(`Job: ${job.id}`);
  lines.push(`Enabled: ${job.enabled}`);
  lines.push(`Schedule: ${formatSchedule(job.schedule)}`);
  if (job.description) lines.push(`Description: ${job.description}`);
  lines.push(`Prompt: ${job.prompt.slice(0, 200)}`);
  lines.push(`Timeout: ${formatDuration(job.timeoutMs ?? DEFAULT_TIMEOUT_MS)}`);
  lines.push(``);
  lines.push(`Runs: ${formatRunCounts(state)}`);
  if (state.lastRunId) lines.push(`Last run: ${state.lastRunId} at ${state.lastFinishedAt}`);
  if (state.lastError) lines.push(`Last error: ${state.lastError}`);
  if (runs.length) {
    lines.push(``);
    lines.push(`Recent runs:`);
    for (const r of runs) {
      lines.push(`  ${formatRunLine(r)}`);
    }
  }
  return lines.join("\n");
}

/** Default empty state for a job */
export function emptyState(id: string): CronJobState {
  return { id, totalRuns: 0, totalSuccesses: 0, totalFailures: 0 };
}

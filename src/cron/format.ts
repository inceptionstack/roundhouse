/**
 * cron/format.ts — Shared cron formatting utilities
 *
 * Used by CLI, gateway /crons, and notifications.
 */

import type { CronSchedule, CronJobConfig, CronJobState, CronRunRecord, CronRunStatus } from "./types";
import { DEFAULT_TIMEOUT_MS } from "./constants";
import { formatDuration } from "./durations";

/** Format a schedule for human-readable display */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.type) {
    case "cron": return `${cronToHuman(schedule.cron)} (${schedule.tz})`;
    case "interval": return `every ${schedule.every}`;
    case "once": return `once at ${schedule.at}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default: return "unknown";
  }
}

/** Convert a 5-field cron expression to human-readable text */
function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;

  const time = formatCronTime(hour, min);
  if (!time) return expr; // complex expression — show raw
  const isRepeating = time.startsWith("every");
  const dayPart = formatCronDays(dom, month, dow);

  if (isRepeating && (!dayPart || dayPart === "daily")) return time;
  if (isRepeating && dayPart) return `${dayPart}, ${time}`;
  if (dayPart) return `${dayPart} at ${time}`;
  return expr; // complex — show raw
}

function formatCronTime(hour: string, min: string): string | null {
  if (hour === "*" && min === "*") return "every minute";
  if (hour.startsWith("*/")) {
    if (min !== "0" && min !== "*") return null; // complex: specific min + repeating hour
    const n = hour.slice(2); return n === "1" ? "every hour" : `every ${n} hours`;
  }
  if (min.startsWith("*/") && hour === "*") { const n = min.slice(2); return n === "1" ? "every minute" : `every ${n} minutes`; }
  if (min.startsWith("*/")) return null; // complex: min repeat + specific hour
  if (hour === "*" && /^\d+$/.test(min)) return `every hour at :${min.padStart(2, "0")}`;
  if (hour === "*") return null; // complex min field

  // Only parse simple numeric values — reject ranges/lists
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(min)) return null;
  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function formatCronDays(dom: string, month: string, dow: string): string {
  const DOW_NAMES: Record<string, string> = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun" };
  const DOW_RANGE: Record<string, string> = { "1-5": "weekdays", "0,6": "weekends", "6,0": "weekends" };

  // Non-* month makes it complex — return empty to trigger raw fallback
  if (month !== "*") return "";

  if (dom === "*" && dow === "*") return "daily";

  if (dom === "*" && dow !== "*") {
    if (DOW_RANGE[dow]) return DOW_RANGE[dow];
    // Handle ranges like 1-3 and lists like 1,3,5
    const days = dow.split(",").map((d) => {
      if (d.includes("-")) {
        const [s, e] = d.split("-");
        return `${DOW_NAMES[s] ?? s}-${DOW_NAMES[e] ?? e}`;
      }
      return DOW_NAMES[d] ?? d;
    }).join(", ");
    return `every ${days}`;
  }

  if (dom !== "*" && dow === "*") {
    return `on day ${dom} of each month`;
  }

  return ""; // complex — both dom + dow set
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

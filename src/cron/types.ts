/**
 * cron/types.ts — Cron job types
 */

// ── Schedule ─────────────────────────────────────────

export type CronSchedule =
  | { type: "cron"; cron: string; tz: string }
  | { type: "interval"; every: string }
  | { type: "once"; at: string; tz?: string };

// ── Job config (persisted as JSON) ───────────────────

export interface CronJobConfig {
  id: string;
  enabled: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;

  schedule: CronSchedule;

  /** Prompt template with {{variable}} placeholders */
  prompt: string;
  /** Custom variables available in template */
  vars?: Record<string, string>;

  /** Timeout for agent run (default 30min) */
  timeoutMs?: number;

  /** Catch-up behavior after gateway restart */
  catchUp?: { mode: "latest" | "none"; };

  /** Notification targets */
  notify?: {
    telegram?: {
      chatIds: (string | number)[];
      onlyOn?: "always" | "success" | "failure";
    };
  };
}

// ── Job state (mutable, persisted separately) ────────

export interface CronJobState {
  id: string;
  lastScheduledAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastRunId?: string;
  lastError?: string;
  totalRuns: number;
  totalSuccesses: number;
  totalFailures: number;
}

// ── Run record ───────────────────────────────────────

export type CronRunStatus = "completed" | "failed" | "timeout" | "abandoned";

export interface CronRunRecord {
  id: string;
  jobId: string;
  kind: "scheduled" | "manual";
  status: CronRunStatus;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  threadId: string;
  prompt: string;
  responseText?: string;
  error?: string;
}

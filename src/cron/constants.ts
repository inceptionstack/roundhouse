/**
 * cron/constants.ts — Shared constants for cron system
 */

/** Default job timeout: 30 minutes */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Default timezone when none specified */
export const DEFAULT_TIMEZONE = "UTC";

/** Scheduler tick interval: 60 seconds */
export const TICK_MS = 60_000;

/** Shutdown grace period: 30 seconds */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Max catch-up iterations to prevent blocking on high-frequency schedules */
export const MAX_CATCHUP_ITERATIONS = 10_000;

/** Default number of recent runs to show */
export const DEFAULT_RUNS_LIMIT = 10;

/** Telegram notification: max response text chars */
export const NOTIFY_MAX_RESPONSE_CHARS = 3500;

/** Telegram notification: max error text chars */
export const NOTIFY_MAX_ERROR_CHARS = 500;


/** Valid notify-on values */
export const VALID_NOTIFY_ON = ["always", "success", "failure"] as const;
export type NotifyOn = (typeof VALID_NOTIFY_ON)[number];

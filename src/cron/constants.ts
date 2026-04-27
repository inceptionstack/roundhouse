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

/** Heartbeat interval: 30 minutes */
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/** Default HEARTBEAT.md content — if file matches this exactly, heartbeat is skipped */
export const HEARTBEAT_DEFAULT_CONTENT = `# Heartbeat Instructions

# Add your recurring tasks below. The agent will check these every 30 minutes.
# If this file is empty or contains only this default text, no action is taken.
#
# Example:
# ## Every heartbeat:
# - Check disk usage and warn if above 80%
# - Check if roundhouse gateway is healthy
#
# ## Every morning:
# - Summarize overnight system events`;

/** Suffix appended to every cron prompt to constrain agent output */
export const CRON_PROMPT_SUFFIX = `

IMPORTANT: You are running as an automated cron job. Your entire text output will be sent as a notification message. Output ONLY the requested content — no preamble, no explanation of what you are, no offers to help with other things. Do not repeat the request. Be concise and direct.`;

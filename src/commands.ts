/**
 * commands.ts — Shared Telegram bot command definitions
 *
 * Single source of truth for bot commands registered with Telegram.
 * Used by both setup (at install time) and gateway (on startup).
 */

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "compact", description: "Compact context window" },
  { command: "verbose", description: "Toggle verbose tool output" },
  { command: "stop", description: "Stop the current agent run" },
  { command: "restart", description: "Restart agent process" },
  { command: "status", description: "Show system status" },
  { command: "doctor", description: "Run diagnostics" },
  { command: "crons", description: "List scheduled cron jobs" },
  { command: "jobs", description: "Show running jobs" },
];

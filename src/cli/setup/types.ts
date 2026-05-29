/**
 * cli/setup/types.ts — Shared types and constants for the setup module
 */

import { resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────

export interface SetupOptions {
  botToken: string;
  users: string[];
  provider: string;
  model: string;
  extensions: string[];
  cwd: string;
  notifyChatIds: (string | number)[];
  systemd: boolean;
  voice: boolean;
  psst: boolean;
  force: boolean;
  dryRun: boolean;
  /** Telegram-focused setup flow */
  telegram: boolean;
  /** Slack-focused setup flow */
  slack: boolean;
  /** Slack bot token (xoxb-…) — only used when slack === true */
  slackBotToken: string;
  /** Slack app token (xapp-…) — only used when slack === true */
  slackAppToken: string;
  /** Slack signing secret (only relevant for webhook mode; v1 ships socket-only) */
  slackSigningSecret: string;
  /** Non-interactive mode (no TTY prompts) */
  nonInteractive: boolean;
  /** QR code display mode */
  qr: "auto" | "always" | "never";
  /** Agent type (default: pi) */
  agent: string;
  /** Whether --agent was explicitly passed on CLI */
  _agentExplicit?: boolean;
  /** Set by detection: skip agent package install if already configured */
  _skipAgentInstall?: boolean;
}

export type StepStatus = "ok" | "warn" | "skip" | "fail";

/** Logger interface passed to setup step functions */
export interface StepLog {
  log(msg: string): void;
  step(n: string, label: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
}

// ── Constants ────────────────────────────────────────

export const PI_SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");
export const DEFAULT_PROVIDER = "amazon-bedrock";
export const DEFAULT_MODEL = "us.anthropic.claude-opus-4-6-v1";
export const EXTENSION_NAME_RE = /^@?[a-z0-9][\w.\-/]*$/i;

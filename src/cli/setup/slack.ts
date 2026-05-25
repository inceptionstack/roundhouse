/**
 * cli/setup/slack.ts — Slack API helpers for `roundhouse setup --slack`.
 *
 * Token validation only — the gateway's @chat-adapter/slack instance
 * does the heavy lifting at runtime. We use auth.test here as a quick
 * "is this xoxb- token valid" check during setup so we fail fast
 * before writing config / starting the service.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SlackBotInfo {
  /** Slack bot user ID (Uxxx) — used for self-loop filtering and pairing fallback. */
  botUserId: string;
  /** Bot display name. */
  botName: string;
  /** Workspace team ID (Txxx). */
  teamId: string;
  /** Workspace name (human-readable). */
  teamName: string;
}

const TOKEN_REDACT_PREFIX = 8;

export function redactSlackToken(token: string): string {
  if (token.length < 12) return "***";
  return token.slice(0, TOKEN_REDACT_PREFIX) + "..." + token.slice(-4);
}

/**
 * Validate a Slack bot token via auth.test.
 *
 * Throws on any failure with the token redacted in the message — never
 * leak xoxb- secrets to logs or error displays.
 */
export async function validateSlackBotToken(botToken: string): Promise<SlackBotInfo> {
  if (!/^xoxb-/.test(botToken)) {
    throw new Error(`Bot token must start with 'xoxb-' (got: ${redactSlackToken(botToken)})`);
  }
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
    // 15s ceiling so a hung Slack endpoint doesn't block setup forever.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Slack auth.test HTTP ${res.status} (token: ${redactSlackToken(botToken)})`);
  }
  const data = await res.json() as {
    ok?: boolean;
    error?: string;
    user_id?: string;
    user?: string;
    team_id?: string;
    team?: string;
  };
  if (!data.ok) {
    throw new Error(`Slack auth.test failed: ${data.error ?? "unknown"} (token: ${redactSlackToken(botToken)})`);
  }
  if (!data.user_id || !data.team_id) {
    throw new Error(`Slack auth.test returned without user_id/team_id (token: ${redactSlackToken(botToken)})`);
  }
  return {
    botUserId: data.user_id,
    botName: data.user ?? "roundhouse",
    teamId: data.team_id,
    teamName: data.team ?? data.team_id,
  };
}

/**
 * Validate the shape of a Slack app-level token (xapp-…). We can't auth.test
 * an app token directly (it's only valid against the socket-mode endpoint),
 * but we can shape-check it so the user catches paste errors during setup.
 */
export function validateSlackAppTokenShape(appToken: string): void {
  if (!/^xapp-\d-[A-Z0-9]+-\d+-[a-f0-9]+$/.test(appToken)) {
    throw new Error(
      `App token shape looks wrong (expected xapp-N-AXXXX-NNN-hex, got: ${redactSlackToken(appToken)}).\n` +
      `Generate one at api.slack.com/apps → Basic Information → App-Level Tokens with the connections:write scope.`
    );
  }
}

/**
 * Read the bundled Slack app manifest YAML.
 *
 * Resolves relative to this module. We probe two candidate paths so we
 * work for both `tsx src/...` (dev: this file at src/cli/setup/slack.ts)
 * and `node src/dist/...` (built: this file at src/dist/index.js after
 * a single-file bundle). The manifest itself is shipped at
 * src/transports/slack/manifest.yaml in the package.
 */
export async function readBundledManifest(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev (tsx): setup/slack.ts → ../../transports/slack/manifest.yaml
    resolve(here, "..", "..", "transports", "slack", "manifest.yaml"),
    // Built (src/dist/): src/dist/index.js → ../transports/slack/manifest.yaml
    resolve(here, "..", "transports", "slack", "manifest.yaml"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch { /* try next */ }
  }
  throw new Error(
    `Could not find Slack manifest. Searched: ${candidates.join(", ")}. ` +
    `Make sure the package's src/transports/slack/manifest.yaml is shipped.`,
  );
}

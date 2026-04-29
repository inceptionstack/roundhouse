/**
 * Credential checks — validates token presence and format.
 * API connectivity is tested by the telegram checks (checks/telegram.ts).
 */

import { readFile } from "node:fs/promises";
import { parseEnvFile } from "../../env-file";
import type { DoctorCheck, DoctorContext } from "../types";

/**
 * Resolve the Telegram bot token from process env or the .env file.
 * Shared by credential and telegram checks.
 */
export async function resolveToken(ctx: DoctorContext): Promise<string | null> {
  let token = ctx.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    try {
      const entries = parseEnvFile(await readFile(ctx.envFilePath, "utf8"));
      const raw = entries.get("TELEGRAM_BOT_TOKEN");
      if (raw) token = raw.replace(/^["']|["']$/g, "");
    } catch {}
  }
  return token || null;
}

export const credentialChecks: DoctorCheck[] = [
  {
    id: "telegram-token", category: "credentials", name: "Telegram bot token",
    async run(ctx) {
      const base = { id: "telegram-token", category: "credentials" as const, name: "Telegram bot token" };
      const token = await resolveToken(ctx);

      if (!token) {
        return {
          ...base, status: "fail", summary: "TELEGRAM_BOT_TOKEN not set",
          details: ["Set TELEGRAM_BOT_TOKEN in your environment or ~/.roundhouse/.env"],
        };
      }
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return {
          ...base, status: "fail", summary: "invalid format",
          details: ["Token should match pattern: digits:alphanumeric"],
        };
      }
      return { ...base, status: "pass", summary: "present, valid format" };
    },
  },
];

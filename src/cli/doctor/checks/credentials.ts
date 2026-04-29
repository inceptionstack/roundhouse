/**
 * Credential checks
 */

import type { DoctorCheck } from "../types";

export const credentialChecks: DoctorCheck[] = [
  {
    id: "telegram-token", category: "credentials", name: "Telegram bot token",
    async run(ctx) {
      // Check both process env and the systemd env file
      let token = ctx.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        try {
          const { readFile } = await import("node:fs/promises");
          const envContent = await readFile(ctx.envFilePath, "utf8");
          const match = envContent.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
          if (match) token = match[1].trim().replace(/^["']|["']$/g, "");
        } catch {}
      }
      if (!token) {
        return {
          id: "telegram-token", category: "credentials", name: "Telegram bot token",
          status: "fail", summary: "TELEGRAM_BOT_TOKEN not set",
          details: ["Set TELEGRAM_BOT_TOKEN in your environment or ~/.roundhouse/.env"],
        };
      }
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return {
          id: "telegram-token", category: "credentials", name: "Telegram bot token",
          status: "fail", summary: "invalid format",
          details: ["Token should match pattern: digits:alphanumeric"],
        };
      }
      // Try getMe
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const username = data.result?.username ?? "unknown";
          return {
            id: "telegram-token", category: "credentials", name: "Telegram bot token",
            status: "pass", summary: `@${username}`,
          };
        }
        return {
          id: "telegram-token", category: "credentials", name: "Telegram bot token",
          status: "fail", summary: `API returned ${res.status}`,
          details: ["Token may be invalid or revoked"],
        };
      } catch (err) {
        return {
          id: "telegram-token", category: "credentials", name: "Telegram bot token",
          status: "warn", summary: "cannot reach Telegram API",
          details: [(err as Error).message],
        };
      }
    },
  },
];

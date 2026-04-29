/**
 * Telegram connectivity checks
 */

import { readFile } from "node:fs/promises";
import type { DoctorCheck } from "../types";
import { parseEnvFile } from "../../env-file";

/** Resolve the bot token from env or .env file */
async function resolveToken(ctx: { env: NodeJS.ProcessEnv; envFilePath: string }): Promise<string | null> {
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

export const telegramChecks: DoctorCheck[] = [
  {
    id: "telegram-configured", category: "network", name: "Telegram adapter configured",
    async run(ctx) {
      const base = { id: "telegram-configured", category: "network" as const, name: "Telegram adapter configured" };
      try {
        const raw = await readFile(ctx.configPath, "utf8");
        const cfg = JSON.parse(raw);
        if (cfg.chat?.adapters?.telegram) {
          const mode = cfg.chat.adapters.telegram.mode ?? "polling";
          return { ...base, status: "pass", summary: `mode: ${mode}` };
        }
        return { ...base, status: "info", summary: "not configured (no telegram adapter in config)" };
      } catch {
        return { ...base, status: "info", summary: "skipped (no config file)" };
      }
    },
  },

  {
    id: "telegram-api", category: "network", name: "Telegram API reachable",
    async run(ctx) {
      const base = { id: "telegram-api", category: "network" as const, name: "Telegram API reachable" };
      const token = await resolveToken(ctx);
      if (!token) {
        return { ...base, status: "info", summary: "skipped (no token)" };
      }

      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          return { ...base, status: "pass", summary: `@${data.result?.username ?? "unknown"}` };
        }
        if (res.status === 401) {
          return { ...base, status: "fail", summary: "401 Unauthorized — token is invalid or revoked" };
        }
        return { ...base, status: "fail", summary: `API returned ${res.status}` };
      } catch (err) {
        return {
          ...base, status: "fail", summary: "cannot reach api.telegram.org",
          details: [(err as Error).message],
        };
      }
    },
  },

  {
    id: "telegram-webhook", category: "network", name: "Telegram webhook status",
    async run(ctx) {
      const base = { id: "telegram-webhook", category: "network" as const, name: "Telegram webhook status" };
      const token = await resolveToken(ctx);
      if (!token) {
        return { ...base, status: "info", summary: "skipped (no token)" };
      }

      // Check what mode is configured
      let configuredMode = "polling";
      try {
        const raw = await readFile(ctx.configPath, "utf8");
        const cfg = JSON.parse(raw);
        configuredMode = cfg.chat?.adapters?.telegram?.mode ?? "polling";
      } catch {}

      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          return { ...base, status: "warn", summary: `getWebhookInfo returned ${res.status}` };
        }
        const data = await res.json() as any;
        const webhookUrl = data.result?.url;
        const pendingUpdates = data.result?.pending_update_count ?? 0;

        if (configuredMode === "polling") {
          if (webhookUrl) {
            return {
              ...base, status: "warn", summary: `webhook set but mode is polling`,
              details: [
                `Webhook URL: ${webhookUrl}`,
                "Polling won't receive updates while a webhook is active.",
                "The gateway will clear this on startup, but if it fails to start, messages are lost.",
              ],
            };
          }
          return { ...base, status: "pass", summary: `no webhook (polling mode), ${pendingUpdates} pending updates` };
        } else {
          // webhook mode
          if (!webhookUrl) {
            return { ...base, status: "warn", summary: "webhook mode configured but no webhook set" };
          }
          return { ...base, status: "pass", summary: `webhook: ${webhookUrl}, ${pendingUpdates} pending` };
        }
      } catch (err) {
        return {
          ...base, status: "warn", summary: "cannot check webhook status",
          details: [(err as Error).message],
        };
      }
    },
  },
];

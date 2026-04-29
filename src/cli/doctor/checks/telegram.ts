/**
 * Telegram connectivity checks — tests API access, config, and webhook status.
 * Token resolution is shared with credentials.ts via resolveToken().
 */

import { readFile } from "node:fs/promises";
import type { DoctorCheck, DoctorContext } from "../types";
import { resolveToken } from "./credentials";

/** Load and parse the gateway config, returning null on any error. */
async function loadGatewayConfig(ctx: DoctorContext): Promise<any | null> {
  try {
    return JSON.parse(await readFile(ctx.configPath, "utf8"));
  } catch {
    return null;
  }
}

export const telegramChecks: DoctorCheck[] = [
  {
    id: "telegram-configured", category: "network", name: "Telegram adapter configured",
    async run(ctx) {
      const base = { id: "telegram-configured", category: "network" as const, name: "Telegram adapter configured" };
      const cfg = await loadGatewayConfig(ctx);
      if (!cfg) {
        return { ...base, status: "info", summary: "skipped (no config file)" };
      }
      if (cfg.chat?.adapters?.telegram) {
        const mode = cfg.chat.adapters.telegram.mode ?? "polling";
        return { ...base, status: "pass", summary: `mode: ${mode}` };
      }
      return { ...base, status: "info", summary: "not configured (no telegram adapter in config)" };
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

      const cfg = await loadGatewayConfig(ctx);
      const configuredMode = cfg?.chat?.adapters?.telegram?.mode ?? "polling";

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
              ...base, status: "warn", summary: "webhook set but mode is polling",
              details: [
                `Webhook URL: ${webhookUrl}`,
                "Polling won't receive updates while a webhook is active.",
                "The gateway will clear this on startup, but if it fails to start, messages are lost.",
              ],
            };
          }
          return { ...base, status: "pass", summary: `no webhook (polling mode), ${pendingUpdates} pending updates` };
        } else {
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

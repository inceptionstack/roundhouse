/**
 * index.ts — Roundhouse entry point
 *
 * Loads config, creates the agent + router + gateway, starts up.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... npm start
 *   TELEGRAM_BOT_TOKEN=... npm start -- --config ./my-config.json
 */

import { getAgentFactory } from "./agents/registry";
import { SingleAgentRouter } from "./router";
import { Gateway } from "./gateway";
import { loadConfig } from "./config";

// ── Crash protection ─────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[roundhouse] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[roundhouse] unhandledRejection:", reason);
});

async function main() {
  const config = await loadConfig();

  // ── Validate ───────────────────────────────────────
  const hasTelegram = config.chat.adapters.telegram;
  if (hasTelegram && !process.env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is required for Telegram adapter.");
    process.exit(1);
  }

  // ── Create agent ───────────────────────────────────
  const { type, ...agentConfig } = config.agent;
  const factory = getAgentFactory(type);
  const agent = factory(agentConfig);
  console.log(`[roundhouse] agent: ${agent.name}`);

  // ── Create router (single agent for now) ───────────
  const router = new SingleAgentRouter(agent);

  // ── Create gateway ─────────────────────────────────
  const gateway = new Gateway(router, config);

  // ── Graceful shutdown ──────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[roundhouse] received ${signal}, shutting down…`);
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Start ──────────────────────────────────────────
  console.log("[roundhouse] starting…");
  await gateway.start();
  console.log("[roundhouse] running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[roundhouse] fatal:", err);
  process.exit(1);
});

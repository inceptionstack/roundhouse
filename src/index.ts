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
import { buildStandingContext } from "./gateway/standing-context";
import { acquireInstanceLock, GatewayAlreadyRunningError } from "./instance-lock";

/** A stop that takes longer than this is cut short: the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

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

  // ── One gateway per host ───────────────────────────
  // Taken before anything polls a chat platform or opens a session.
  let lock;
  try {
    lock = await acquireInstanceLock();
  } catch (err) {
    if (err instanceof GatewayAlreadyRunningError) {
      console.error(`[roundhouse] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", () => lock.release());

  // ── Create agent ───────────────────────────────────
  const { type, ...agentConfig } = config.agent;
  const factory = getAgentFactory(type);
  // Persona and tool notes go to the adapter as a function: one that can put
  // them in its system prompt does (pi), and the gateway then skips the
  // per-message copy. Others ignore it and keep the per-message copy.
  const agent = factory({ ...agentConfig, standingContext: buildStandingContext });
  console.log(`[roundhouse] agent: ${agent.name}`);

  // ── Create router (single agent for now) ───────────
  const router = new SingleAgentRouter(agent);

  // ── Create gateway ─────────────────────────────────
  const gateway = new Gateway(router, config);

  // ── Graceful shutdown ──────────────────────────────
  // A stop must end the process, whatever is in flight: a gateway that
  // lingers after its service was restarted shares the bot and the session
  // files with its successor. So: say we are stopping (the successor waits
  // for that), stop, and exit when the stop is done or the deadline passes.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[roundhouse] received ${signal}, shutting down…`);
    lock.markStopping();
    const deadline = setTimeout(() => {
      console.error(`[roundhouse] shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS / 1000}s; exiting`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      await gateway.stop();
    } catch (err) {
      console.error("[roundhouse] error during shutdown:", err);
    }
    clearTimeout(deadline);
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

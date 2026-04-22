/**
 * index.ts — Roundhouse entry point
 *
 * Loads config, creates the agent + router + gateway, starts up.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... npm start
 *   TELEGRAM_BOT_TOKEN=... npm start -- --config ./my-config.json
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { GatewayConfig } from "./types";
import { getAgentFactory } from "./agents/registry";
import { SingleAgentRouter } from "./router";
import { Gateway } from "./gateway";

// ── Crash protection ─────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[roundhouse] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[roundhouse] unhandledRejection:", reason);
});

// ── Default config ───────────────────────────────────
const DEFAULT_CONFIG: GatewayConfig = {
  agent: {
    type: "pi",
    cwd: process.cwd(),
  },
  chat: {
    botUsername: process.env.BOT_USERNAME ?? "roundhouse_bot",
    allowedUsers: process.env.ALLOWED_USERS
      ? process.env.ALLOWED_USERS.split(",").map((u) => u.trim())
      : [],
    adapters: {
      telegram: { mode: "polling" },
    },
  },
};

async function loadConfig(): Promise<GatewayConfig> {
  // Check for ROUNDHOUSE_CONFIG env var (set by CLI/daemon)
  const envConfig = process.env.ROUNDHOUSE_CONFIG;
  if (envConfig) {
    try {
      const raw = await readFile(resolve(envConfig), "utf8");
      console.log(`[roundhouse] loaded config from ${envConfig}`);
      return JSON.parse(raw) as GatewayConfig;
    } catch {
      // Fall through to other methods
    }
  }

  // Check for --config flag
  const configIdx = process.argv.indexOf("--config");
  if (configIdx !== -1 && process.argv[configIdx + 1]) {
    const configPath = resolve(process.argv[configIdx + 1]);
    console.log(`[roundhouse] loading config from ${configPath}`);
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as GatewayConfig;
  }

  // Try gateway.config.json in cwd
  try {
    const raw = await readFile(
      resolve(process.cwd(), "gateway.config.json"),
      "utf8"
    );
    console.log("[roundhouse] loaded gateway.config.json");
    return JSON.parse(raw) as GatewayConfig;
  } catch {
    // Fall back to defaults + env vars
    console.log("[roundhouse] using default config + env vars");
    return DEFAULT_CONFIG;
  }
}

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

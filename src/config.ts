/**
 * config.ts — Shared configuration for roundhouse
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFile, access } from "node:fs/promises";
import type { GatewayConfig } from "./types";

export const CONFIG_DIR = resolve(homedir(), ".config", "roundhouse");
export const CONFIG_PATH = resolve(CONFIG_DIR, "gateway.config.json");
export const SERVICE_NAME = "roundhouse";

/**
 * Default config written to disk by `roundhouse install`.
 * Uses static, safe defaults — env vars are resolved at runtime by loadConfig(),
 * not baked into the persisted file.
 */
export const DEFAULT_CONFIG: GatewayConfig = {
  agent: {
    type: "pi",
    cwd: homedir(),
  },
  chat: {
    botUsername: "roundhouse_bot",
    allowedUsers: [],
    adapters: {
      telegram: { mode: "polling" },
    },
  },
};

/**
 * Build a runtime config by overlaying environment variables onto a base config.
 */
export function applyEnvOverrides(config: GatewayConfig): GatewayConfig {
  return {
    ...config,
    agent: {
      ...config.agent,
      cwd: (typeof config.agent.cwd === "string" && config.agent.cwd) ? config.agent.cwd : process.cwd(),
    },
    chat: {
      ...config.chat,
      botUsername: process.env.BOT_USERNAME ?? config.chat.botUsername,
      allowedUsers: process.env.ALLOWED_USERS
        ? process.env.ALLOWED_USERS.split(",").map((u) => u.trim())
        : config.chat.allowedUsers,
      notifyChatIds: process.env.NOTIFY_CHAT_IDS
        ? process.env.NOTIFY_CHAT_IDS.split(",").map((id) => id.trim())
        : config.chat.notifyChatIds,
    },
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<GatewayConfig> {
  let config: GatewayConfig | undefined;

  // Check for ROUNDHOUSE_CONFIG env var (set by CLI/daemon — must be valid)
  const envConfig = process.env.ROUNDHOUSE_CONFIG;
  if (envConfig) {
    try {
      const raw = await readFile(resolve(envConfig), "utf8");
      console.log(`[roundhouse] loaded config from ${envConfig}`);
      config = JSON.parse(raw) as GatewayConfig;
    } catch (err: any) {
      console.error(`[roundhouse] failed to load config from ROUNDHOUSE_CONFIG=${envConfig}: ${err.message}`);
      process.exit(1);
    }
  }

  // Check for --config flag
  if (!config) {
    const configIdx = process.argv.indexOf("--config");
    if (configIdx !== -1 && process.argv[configIdx + 1]) {
      const configPath = resolve(process.argv[configIdx + 1]);
      try {
        const raw = await readFile(configPath, "utf8");
        console.log(`[roundhouse] loaded config from ${configPath}`);
        config = JSON.parse(raw) as GatewayConfig;
      } catch (err: any) {
        console.error(`[roundhouse] failed to load config from ${configPath}: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // Try gateway.config.json in cwd
  if (!config) {
    try {
      const raw = await readFile(
        resolve(process.cwd(), "gateway.config.json"),
        "utf8"
      );
      console.log("[roundhouse] loaded gateway.config.json");
      config = JSON.parse(raw) as GatewayConfig;
    } catch {
      console.log("[roundhouse] using default config + env vars");
      config = DEFAULT_CONFIG;
    }
  }

  // Apply runtime env var overrides (BOT_USERNAME, ALLOWED_USERS, etc.)
  return applyEnvOverrides(config);
}

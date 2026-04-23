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

export const DEFAULT_CONFIG: GatewayConfig = {
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<GatewayConfig> {
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
    console.log("[roundhouse] using default config + env vars");
    return DEFAULT_CONFIG;
  }
}

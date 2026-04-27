/**
 * config.ts — Shared configuration for roundhouse
 *
 * Canonical config directory: ~/.roundhouse/
 * Legacy fallback: ~/.config/roundhouse/ (deprecated, will warn)
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFile, access } from "node:fs/promises";
import type { GatewayConfig } from "./types";

// ── Path constants ───────────────────────────────────

/** New canonical config root */
export const ROUNDHOUSE_DIR = resolve(homedir(), ".roundhouse");

/** Legacy config root (deprecated) */
export const LEGACY_CONFIG_DIR = resolve(homedir(), ".config", "roundhouse");

/** Active config directory — use ROUNDHOUSE_DIR */
export const CONFIG_DIR = ROUNDHOUSE_DIR;
export const CONFIG_PATH = resolve(ROUNDHOUSE_DIR, "gateway.config.json");
export const ENV_FILE_PATH = resolve(ROUNDHOUSE_DIR, "env");

/** Cron directories */
export const CRON_JOBS_DIR = resolve(ROUNDHOUSE_DIR, "crons");
export const CRON_STATE_DIR = resolve(ROUNDHOUSE_DIR, "cron-state");
export const CRON_RUNS_DIR = resolve(ROUNDHOUSE_DIR, "cron-runs");

export const SERVICE_NAME = "roundhouse";

/**
 * Default config written to disk by `roundhouse install`.
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
        ? process.env.NOTIFY_CHAT_IDS.split(",").map((id) => Number(id.trim())).filter((n) => !isNaN(n))
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

/**
 * Resolve config path with legacy fallback.
 * Returns the path that actually has a config file, or the new canonical path.
 */
let configPathWarned = false;

export async function resolveConfigPath(): Promise<{ path: string; legacy: boolean }> {
  // New path takes priority
  if (await fileExists(CONFIG_PATH)) {
    return { path: CONFIG_PATH, legacy: false };
  }
  // Legacy fallback
  const legacyPath = resolve(LEGACY_CONFIG_DIR, "gateway.config.json");
  if (await fileExists(legacyPath)) {
    if (!configPathWarned) {
      configPathWarned = true;
      console.warn(`[roundhouse] ⚠️  Config found at legacy path: ${legacyPath}`);
      console.warn(`[roundhouse]    Move it to ${CONFIG_PATH} — legacy path will be removed in a future version.`);
    }
    return { path: legacyPath, legacy: true };
  }
  return { path: CONFIG_PATH, legacy: false };
}

/**
 * Resolve env file path with legacy fallback.
 */
let envFileWarned = false;

export async function resolveEnvFilePath(): Promise<string> {
  if (await fileExists(ENV_FILE_PATH)) return ENV_FILE_PATH;
  const legacyEnv = resolve(LEGACY_CONFIG_DIR, "env");
  if (await fileExists(legacyEnv)) {
    if (!envFileWarned) {
      envFileWarned = true;
      console.warn(`[roundhouse] \u26a0\ufe0f  Env file found at legacy path: ${legacyEnv}`);
      console.warn(`[roundhouse]    Move it to ${ENV_FILE_PATH} \u2014 legacy path will be removed in a future version.`);
    }
    return legacyEnv;
  }
  return ENV_FILE_PATH;
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

  // Try canonical path, then legacy, then cwd
  if (!config) {
    const resolved = await resolveConfigPath();
    try {
      const raw = await readFile(resolved.path, "utf8");
      console.log(`[roundhouse] loaded config from ${resolved.path}`);
      config = JSON.parse(raw) as GatewayConfig;
    } catch (err: any) {
      // File not found → try cwd. Parse error on existing file → fail fast.
      if (err.code !== "ENOENT") {
        console.error(`[roundhouse] failed to parse config at ${resolved.path}: ${err.message}`);
        process.exit(1);
      }
      // Try cwd
      try {
        const cwdPath = resolve(process.cwd(), "gateway.config.json");
        const raw = await readFile(cwdPath, "utf8");
        console.log("[roundhouse] loaded gateway.config.json from cwd");
        config = JSON.parse(raw) as GatewayConfig;
      } catch (cwdErr: any) {
        if (cwdErr.code !== "ENOENT") {
          console.error(`[roundhouse] failed to parse config at ./gateway.config.json: ${cwdErr.message}`);
          process.exit(1);
        }
        console.log("[roundhouse] using default config + env vars");
        config = DEFAULT_CONFIG;
      }
    }
  }

  return applyEnvOverrides(config);
}

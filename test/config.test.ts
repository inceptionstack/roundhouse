import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyEnvOverrides, DEFAULT_CONFIG } from "../src/config";
import type { GatewayConfig } from "../src/types";

// ─────────────────────────────────────────────────────
// DEFAULT_CONFIG
// ─────────────────────────────────────────────────────

describe("DEFAULT_CONFIG", () => {
  it("uses homedir for cwd, not process.cwd()", () => {
    const { homedir } = require("node:os");
    expect(DEFAULT_CONFIG.agent.cwd).toBe(homedir());
  });

  it("has static botUsername, not env-derived", () => {
    expect(DEFAULT_CONFIG.chat.botUsername).toBe("roundhouse_bot");
  });

  it("has empty allowedUsers, not env-derived", () => {
    expect(DEFAULT_CONFIG.chat.allowedUsers).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────
// applyEnvOverrides
// ─────────────────────────────────────────────────────

describe("applyEnvOverrides", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const baseConfig: GatewayConfig = {
    agent: { type: "pi", cwd: "/home/test" },
    chat: {
      botUsername: "my_bot",
      allowedUsers: ["alice"],
      adapters: { telegram: { mode: "polling" } },
    },
  };

  it("preserves existing config values when no env vars set", () => {
    delete process.env.BOT_USERNAME;
    delete process.env.ALLOWED_USERS;
    const result = applyEnvOverrides(baseConfig);
    expect(result.agent.cwd).toBe("/home/test");
    expect(result.chat.botUsername).toBe("my_bot");
    expect(result.chat.allowedUsers).toEqual(["alice"]);
  });

  it("overrides botUsername from BOT_USERNAME env var", () => {
    process.env.BOT_USERNAME = "env_bot";
    const result = applyEnvOverrides(baseConfig);
    expect(result.chat.botUsername).toBe("env_bot");
  });

  it("overrides allowedUsers from ALLOWED_USERS env var", () => {
    process.env.ALLOWED_USERS = "bob, charlie";
    const result = applyEnvOverrides(baseConfig);
    expect(result.chat.allowedUsers).toEqual(["bob", "charlie"]);
  });

  it("falls back to process.cwd() when cwd is undefined", () => {
    const noAgent: GatewayConfig = {
      agent: { type: "pi" },
      chat: baseConfig.chat,
    };
    const result = applyEnvOverrides(noAgent);
    expect(result.agent.cwd).toBe(process.cwd());
  });

  it("falls back to process.cwd() when cwd is null", () => {
    const nullCwd: GatewayConfig = {
      agent: { type: "pi", cwd: null },
      chat: baseConfig.chat,
    };
    const result = applyEnvOverrides(nullCwd);
    expect(result.agent.cwd).toBe(process.cwd());
  });

  it("falls back to process.cwd() when cwd is empty string", () => {
    const emptyCwd: GatewayConfig = {
      agent: { type: "pi", cwd: "" },
      chat: baseConfig.chat,
    };
    const result = applyEnvOverrides(emptyCwd);
    expect(result.agent.cwd).toBe(process.cwd());
  });

  it("falls back to process.cwd() when cwd is a non-string", () => {
    const numCwd: GatewayConfig = {
      agent: { type: "pi", cwd: 42 },
      chat: baseConfig.chat,
    };
    const result = applyEnvOverrides(numCwd);
    expect(result.agent.cwd).toBe(process.cwd());
  });

  it("keeps valid string cwd as-is", () => {
    const result = applyEnvOverrides(baseConfig);
    expect(result.agent.cwd).toBe("/home/test");
  });

  it("does not mutate the original config", () => {
    process.env.BOT_USERNAME = "mutant";
    const before = JSON.parse(JSON.stringify(baseConfig));
    applyEnvOverrides(baseConfig);
    expect(baseConfig).toEqual(before);
  });
});

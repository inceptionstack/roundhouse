/**
 * test/setup.test.ts — Unit tests for setup arg parsing and config generation
 */

import { describe, it, expect } from "vitest";
import { parseSetupArgs } from "../src/cli/setup";

describe("parseSetupArgs", () => {
  it("parses minimum required flags", () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
    try {
      const opts = parseSetupArgs(["--user", "alice"]);
      expect(opts.botToken).toBe("test-token-123");
      expect(opts.users).toEqual(["alice"]);
      expect(opts.provider).toBe("amazon-bedrock");
      expect(opts.model).toBe("us.anthropic.claude-opus-4-6-v1");
      expect(opts.extensions).toEqual([]);
      expect(opts.psst).toBe(false);
      expect(opts.force).toBe(false);
      expect(opts.dryRun).toBe(false);
      expect(opts.nonInteractive).toBe(false);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("parses --bot-token flag", () => {
    const opts = parseSetupArgs(["--bot-token", "flag-token", "--user", "bob"]);
    expect(opts.botToken).toBe("flag-token");
  });

  it("--bot-token flag takes priority over env", () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    try {
      const opts = parseSetupArgs(["--bot-token", "flag-token", "--user", "bob"]);
      expect(opts.botToken).toBe("flag-token");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("parses multiple --user flags", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "alice", "--user", "bob"]);
    expect(opts.users).toEqual(["alice", "bob"]);
  });

  it("strips @ from usernames", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "@alice"]);
    expect(opts.users).toEqual(["alice"]);
  });

  it("parses provider and model", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "a", "--provider", "anthropic", "--model", "claude-sonnet-4-20250514"]);
    expect(opts.provider).toBe("anthropic");
    expect(opts.model).toBe("claude-sonnet-4-20250514");
  });

  it("parses multiple extensions", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "a", "--extension", "@samfp/pi-memory", "--extension", "pi-napkin"]);
    expect(opts.extensions).toEqual(["@samfp/pi-memory", "pi-napkin"]);
  });

  it("parses --cwd", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "a", "--cwd", "/tmp/workspace"]);
    expect(opts.cwd).toBe("/tmp/workspace");
  });

  it("parses --notify-chat", () => {
    const opts = parseSetupArgs(["--bot-token", "t", "--user", "a", "--notify-chat", "12345", "--notify-chat", "67890"]);
    expect(opts.notifyChatIds).toEqual([12345, 67890]);
  });

  it("parses boolean flags", () => {
    const opts = parseSetupArgs([
      "--bot-token", "t", "--user", "a",
      "--no-systemd", "--no-voice", "--with-psst",
      "--non-interactive", "--force", "--dry-run",
    ]);
    expect(opts.systemd).toBe(false);
    expect(opts.voice).toBe(false);
    expect(opts.psst).toBe(true);
    expect(opts.nonInteractive).toBe(true);
    expect(opts.force).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it("throws on missing token", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => parseSetupArgs(["--user", "a"])).toThrow(/Bot token required/);
  });

  it("throws on missing user", () => {
    expect(() => parseSetupArgs(["--bot-token", "t"])).toThrow(/at least one --user/i);
  });

  it("throws on invalid extension name", () => {
    expect(
      () => parseSetupArgs(["--bot-token", "t", "--user", "a", "--extension", "; rm -rf /"]),
    ).toThrow(/Invalid extension name/);
  });

  it("throws on unknown flag", () => {
    expect(
      () => parseSetupArgs(["--bot-token", "t", "--user", "a", "--bogus"]),
    ).toThrow(/Unknown flag/);
  });

  it("throws on missing flag value", () => {
    expect(
      () => parseSetupArgs(["--bot-token", "t", "--user"]),
    ).toThrow(/Missing value/);
  });

  it("throws on invalid notify-chat (NaN)", () => {
    expect(
      () => parseSetupArgs(["--bot-token", "t", "--user", "a", "--notify-chat", "abc"]),
    ).toThrow(/must be a number/);
  });
});

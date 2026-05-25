/**
 * test/setup-slack.test.ts — `roundhouse setup --slack` argument parsing
 * and Slack-helper unit tests.
 */

import { describe, it, expect } from "vitest";
import { parseSetupArgs } from "../src/cli/setup/args";
import {
  redactSlackToken,
  validateSlackAppTokenShape,
  readBundledManifest,
} from "../src/cli/setup/slack";

describe("parseSetupArgs --slack", () => {
  it("accepts --slack with required tokens via flags", () => {
    const opts = parseSetupArgs([
      "--slack",
      "--slack-bot-token", "xoxb-test-placeholder",
      "--slack-app-token", "xapp-1-A0123456789-1234567890-abcd1234ef567890",
      "--user", "alice",
    ]);
    expect(opts.slack).toBe(true);
    expect(opts.slackBotToken).toMatch(/^xoxb-/);
    expect(opts.slackAppToken).toMatch(/^xapp-/);
    expect(opts.users).toEqual(["alice"]);
  });

  it("rejects --telegram and --slack together", () => {
    expect(() => parseSetupArgs(["--telegram", "--slack", "--user", "alice"]))
      .toThrow(/mutually exclusive/);
  });

  it("rejects bot token with wrong prefix", () => {
    expect(() => parseSetupArgs([
      "--slack",
      "--slack-bot-token", "xoxa-malformed",
      "--slack-app-token", "xapp-1-A1-1-abc",
      "--user", "alice",
    ])).toThrow(/must start with `xoxb-`/);
  });

  it("rejects app token with wrong prefix", () => {
    expect(() => parseSetupArgs([
      "--slack",
      "--slack-bot-token", "xoxb-ok",
      "--slack-app-token", "xoxb-wrong",
      "--user", "alice",
    ])).toThrow(/must start with `xapp-`/);
  });

  it("rejects --slack-bot-token in --non-interactive mode (argv leakage)", () => {
    expect(() => parseSetupArgs([
      "--slack", "--non-interactive",
      "--slack-bot-token", "xoxb-1234",
      "--user", "alice",
    ])).toThrow(/argv visible in process listings/);
  });

  it("falls back to env vars when flags omitted", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-from-env";
    process.env.SLACK_APP_TOKEN = "xapp-from-env";
    try {
      const opts = parseSetupArgs(["--slack", "--user", "alice"]);
      expect(opts.slackBotToken).toBe("xoxb-from-env");
      expect(opts.slackAppToken).toBe("xapp-from-env");
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
    }
  });
});

describe("redactSlackToken", () => {
  it("preserves prefix + last 4 chars so users can identify which token is broken", () => {
    expect(redactSlackToken("xoxb-12345678-90ABCDEF-rest1234")).toBe("xoxb-123...1234");
  });

  it("returns *** for too-short input (avoid leaking partial)", () => {
    expect(redactSlackToken("short")).toBe("***");
  });
});

describe("validateSlackAppTokenShape", () => {
  it("accepts well-formed xapp tokens", () => {
    expect(() =>
      validateSlackAppTokenShape("xapp-1-A0123456789-1234567890-abcd1234ef567890ab1234cd5678ef9012"),
    ).not.toThrow();
  });

  it("rejects malformed app tokens with a redacted error", () => {
    try {
      validateSlackAppTokenShape("xapp-not-real");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/App token shape/);
      // The error redacts; "xapp-not-" should not appear in full
      expect((err as Error).message).not.toContain("xapp-not-real");
    }
  });
});

describe("readBundledManifest", () => {
  it("loads the YAML manifest including required scopes", async () => {
    const manifest = await readBundledManifest();
    expect(manifest).toContain("display_information:");
    expect(manifest).toContain("assistant:write");
    expect(manifest).toContain("socket_mode_enabled: true");
    expect(manifest).toContain("assistant_thread_started");
    // Privacy: ensure we don't request users:read.email — flagged in plan
    expect(manifest).not.toContain("users:read.email");
  });
});

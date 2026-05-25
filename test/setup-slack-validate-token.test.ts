/**
 * test/setup-slack-validate-token.test.ts — validateSlackBotToken with mocked fetch.
 *
 * Bar: the function must (a) call auth.test against Slack with the bot
 * token in Authorization, (b) parse user_id/team_id on success, (c) NEVER
 * leak the raw token in any error message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateSlackBotToken } from "../src/cli/setup/slack";

const FAKE_TOKEN = "xoxb-99999-99999-loaderXyzAbcDefGhi";

describe("validateSlackBotToken", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects token with wrong prefix without hitting the network", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    await expect(validateSlackBotToken("xoxa-not-a-bot")).rejects.toThrow(/must start with 'xoxb-'/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns SlackBotInfo on a successful auth.test", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        user_id: "U02BOT",
        user: "roundhouse",
        team_id: "T01TEAM",
        team: "Acme",
      }),
    } as any)) as any;

    const info = await validateSlackBotToken(FAKE_TOKEN);
    expect(info).toEqual({
      botUserId: "U02BOT",
      botName: "roundhouse",
      teamId: "T01TEAM",
      teamName: "Acme",
    });
  });

  it("on Slack-side failure (ok:false), throws with the redacted token", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error: "invalid_auth" }),
    } as any)) as any;

    try {
      await validateSlackBotToken(FAKE_TOKEN);
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("invalid_auth");
      // Redacted form: "xoxb-999...XyzAbc" (prefix 8 + last 4)
      expect(msg).toContain("xoxb-999");
      // The full token must NEVER appear in the error
      expect(msg).not.toContain(FAKE_TOKEN);
    }
  });

  it("on HTTP failure throws with the redacted token", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
    } as any)) as any;

    try {
      await validateSlackBotToken(FAKE_TOKEN);
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/HTTP 500/);
      expect(msg).not.toContain(FAKE_TOKEN);
    }
  });

  it("when auth.test returns OK but missing user_id/team_id, throws (defensive)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true /* missing user_id/team_id */ }),
    } as any)) as any;

    await expect(validateSlackBotToken(FAKE_TOKEN)).rejects.toThrow(/without user_id\/team_id/);
  });
});

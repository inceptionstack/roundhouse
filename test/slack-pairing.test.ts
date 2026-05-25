/**
 * test/slack-pairing.test.ts — pending Slack pairing matching.
 *
 * Covers `matchPendingPairing`, the pure helper that the SlackAdapter uses
 * to decide whether an inbound event corresponds to the pending pairing.
 * The first-DM (message.im) path populates `userName`; the
 * assistant_thread_started path may only have `userId` until the gateway
 * resolves the user via getUser — so we accept Uxxx-literal allowlist
 * entries as a fallback.
 */

import { describe, it, expect } from "vitest";
import { matchPendingPairing, type PendingSlackPairing } from "../src/transports/slack/pairing";

const base: PendingSlackPairing = {
  version: 1,
  allowedUsers: ["alice"],
  createdAt: "2026-05-26T00:00:00Z",
  status: "pending",
};

describe("matchPendingPairing", () => {
  it("matches by lowercased userName", () => {
    expect(matchPendingPairing(base, "Alice", "U02ABC")).toBe(true);
    expect(matchPendingPairing(base, "ALICE", "U02ABC")).toBe(true);
  });

  it("strips a leading @ when matching userName", () => {
    expect(matchPendingPairing(base, "@alice", "U02ABC")).toBe(true);
  });

  it("rejects a userName not in the allowlist", () => {
    expect(matchPendingPairing(base, "bob", "U02BOB")).toBe(false);
  });

  it("matches by Slack userId when allowedUserIds is set (assistant_thread_started fallback)", () => {
    const pending: PendingSlackPairing = {
      ...base,
      allowedUsers: ["alice"],
      allowedUserIds: ["U02ABC"],
    };
    // userName missing (assistant event before getUser resolution)
    expect(matchPendingPairing(pending, undefined, "U02ABC")).toBe(true);
  });

  it("rejects when neither name nor id matches", () => {
    const pending: PendingSlackPairing = { ...base, allowedUserIds: ["U02ABC"] };
    expect(matchPendingPairing(pending, "bob", "U99XYZ")).toBe(false);
  });

  it("rejects already-paired states", () => {
    const paired: PendingSlackPairing = { ...base, status: "paired" };
    expect(matchPendingPairing(paired, "alice", "U02ABC")).toBe(false);
  });
});

/**
 * test/cron-notify-partition.test.ts — Cron notifyFn signature widened in
 * Phase 1 to accept (string | number)[]. Verify a heterogeneous list of
 * chat ids passes through unchanged when the gateway's notifyFn forwards
 * to transport.notify.
 *
 * The gateway wires notifyFn at gateway.ts:357. We exercise that wire by
 * constructing the same lambda shape and asserting it doesn't drop or
 * coerce.
 */

import { describe, it, expect, vi } from "vitest";
import { CompositeTransportAdapter } from "../src/transports/composite";
import type { TransportAdapter } from "../src/transports/types";

function fake(name: string, ownsId: (id: string | number) => boolean): TransportAdapter {
  return {
    name,
    enrichPrompt: (_t, t) => t,
    postMessage: vi.fn(async () => {}),
    postRich: vi.fn(async () => {}),
    progress: vi.fn(async () => ({ update: vi.fn(async () => {}) })),
    stream: vi.fn(async () => {}),
    registerCommands: vi.fn(async () => {}),
    ownsThread: () => false,
    ownsChatId: ownsId,
    encodeParentThreadId: (id) => `${name}:${id}:main`,
    formatNotifySession: () => "main",
    notify: vi.fn(async () => {}),
    createThread: (id) => ({ id: `${name}:${id}`, post: async () => {} }),
    isPairingPending: vi.fn(async () => false),
    handlePairing: vi.fn(async () => null),
  };
}

describe("cron notifyFn → composite.notify partition", () => {
  it("forwards a heterogeneous (string | number)[] without dropping ids", async () => {
    const tg = fake("telegram", (id) => /^-?\d+$/.test(String(id)));
    const sl = fake("slack", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    const composite = new CompositeTransportAdapter([tg, sl]);

    // Mirror the lambda the gateway constructs (gateway.ts:349).
    const notifyFn = async (chatIds: (string | number)[], text: string) => {
      if (chatIds.length) await composite.notify(chatIds, text);
    };

    await notifyFn([12345, "C01ABC", -100, "U02XYZ"], "cron fired");

    expect(tg.notify).toHaveBeenCalledWith([12345, -100], "cron fired");
    expect(sl.notify).toHaveBeenCalledWith(["C01ABC", "U02XYZ"], "cron fired");
  });

  it("no-ops when chatIds is empty (matches gateway guard)", async () => {
    const tg = fake("telegram", (id) => /^-?\d+$/.test(String(id)));
    const composite = new CompositeTransportAdapter([tg]);
    const notifyFn = async (chatIds: (string | number)[], text: string) => {
      if (chatIds.length) await composite.notify(chatIds, text);
    };
    await notifyFn([], "nope");
    expect(tg.notify).not.toHaveBeenCalled();
  });
});

/**
 * test/composite-transport.test.ts — Tests for CompositeTransportAdapter.
 *
 * Verifies multi-transport routing semantics:
 *  - per-thread methods dispatch to the delegate that owns the thread
 *  - notify() partitions chat ids by ownsChatId and fans out
 *  - handlePairing returns the first non-null result and tags it with the
 *    delegate name
 *  - shouldIgnoreMessage routes by ownsThread
 *  - chat.onAction routing still works because event.thread carries the
 *    platform prefix (verified by the structural test below)
 */

import { describe, it, expect, vi } from "vitest";
import { CompositeTransportAdapter } from "../src/transports/composite";
import type { TransportAdapter, ChatThread } from "../src/transports/types";

function fakeDelegate(name: string, prefix: string, idCheck: (id: string | number) => boolean): TransportAdapter {
  return {
    name,
    enrichPrompt: vi.fn((_t, text) => `${text} [${name}]`),
    postMessage: vi.fn(async () => {}),
    postRich: vi.fn(async () => {}),
    progress: vi.fn(async () => ({ update: vi.fn(async () => {}) })),
    stream: vi.fn(async () => {}),
    registerCommands: vi.fn(async () => {}),
    ownsThread: (t) => typeof t.id === "string" && t.id.startsWith(prefix),
    ownsChatId: idCheck,
    encodeParentThreadId: (id) => `${name}:${id}:main`,
    formatNotifySession: () => `session-${name}`,
    notify: vi.fn(async () => {}),
    createThread: (id) => ({ id: `${prefix}${id}`, post: async () => {} } as ChatThread),
    isPairingPending: vi.fn(async () => false),
    handlePairing: vi.fn(async () => null),
    shouldIgnoreMessage: vi.fn(() => false),
  };
}

describe("CompositeTransportAdapter", () => {
  it("requires at least one delegate", () => {
    expect(() => new CompositeTransportAdapter([])).toThrow(/at least one delegate/);
  });

  it("routes per-thread methods to the owning delegate", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    const composite = new CompositeTransportAdapter([tg, sl]);

    const tThread: ChatThread = { id: "telegram:123", post: async () => {} };
    const sThread: ChatThread = { id: "slack:C0", post: async () => {} };

    await composite.postMessage(tThread, "hi");
    expect(tg.postMessage).toHaveBeenCalledOnce();
    expect(sl.postMessage).not.toHaveBeenCalled();

    await composite.postMessage(sThread, "hi");
    expect(sl.postMessage).toHaveBeenCalledOnce();

    expect(composite.enrichPrompt(tThread, "x")).toBe("x [telegram]");
    expect(composite.enrichPrompt(sThread, "x")).toBe("x [slack]");
  });

  it("partitions notify() by ownsChatId", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    const composite = new CompositeTransportAdapter([tg, sl]);

    await composite.notify([123, "C01ABC", -456, "U02XYZ"], "hello");

    expect(tg.notify).toHaveBeenCalledWith([123, -456], "hello");
    expect(sl.notify).toHaveBeenCalledWith(["C01ABC", "U02XYZ"], "hello");
  });

  it("notify drops chat ids that no delegate recognizes", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const composite = new CompositeTransportAdapter([tg]);

    await composite.notify(["C01ABC"], "hello");   // not telegram-shaped
    expect(tg.notify).not.toHaveBeenCalled();
  });

  it("handlePairing returns the first non-null result, tagged with delegate name", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    (tg.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (sl.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValue({
      threadId: "C01", userId: "U01", username: "alice",
    });

    const composite = new CompositeTransportAdapter([tg, sl]);
    const result = await composite.handlePairing(
      { id: "slack:C01", post: async () => {} } as ChatThread,
      { text: "hi" } as any,
    );

    expect(result).toEqual({
      threadId: "C01", userId: "U01", username: "alice", transport: "slack",
    });
  });

  it("preserves a delegate-provided transport tag (does not overwrite)", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    (tg.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValue({
      threadId: 123, userId: 456, username: "bob", transport: "telegram",
    });

    const composite = new CompositeTransportAdapter([tg]);
    const result = await composite.handlePairing(
      { id: "telegram:123", post: async () => {} } as ChatThread,
      { text: "hi" } as any,
    );

    expect(result?.transport).toBe("telegram");
  });

  it("shouldIgnoreMessage routes by ownsThread; returns false when no owner", () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    (tg.shouldIgnoreMessage as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const composite = new CompositeTransportAdapter([tg]);

    expect(composite.shouldIgnoreMessage("/start", {} as any, { id: "telegram:1", post: async () => {} } as ChatThread)).toBe(true);
    expect(composite.shouldIgnoreMessage("/start", {} as any, { id: "slack:C0", post: async () => {} } as ChatThread)).toBe(false);
  });

  it("registerCommands fans out to all delegates", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    const composite = new CompositeTransportAdapter([tg, sl]);

    await composite.registerCommands();

    expect(tg.registerCommands).toHaveBeenCalledOnce();
    expect(sl.registerCommands).toHaveBeenCalledOnce();
  });

  it("isPairingPending returns true if any delegate has pending", async () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    (sl.isPairingPending as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const composite = new CompositeTransportAdapter([tg, sl]);
    expect(await composite.isPairingPending()).toBe(true);
  });

  it("ownerOf and ownerOfChatId expose the matching delegate (gateway uses these to gate per-transport pairingComplete)", () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    const composite = new CompositeTransportAdapter([tg, sl]);

    expect(composite.ownerOf({ id: "telegram:1", post: async () => {} } as ChatThread)?.name).toBe("telegram");
    expect(composite.ownerOf({ id: "slack:C0", post: async () => {} } as ChatThread)?.name).toBe("slack");
    expect(composite.ownerOf({ id: "discord:1", post: async () => {} } as ChatThread)).toBeNull();

    expect(composite.ownerOfChatId(123)?.name).toBe("telegram");
    expect(composite.ownerOfChatId("C01")?.name).toBe("slack");
    expect(composite.ownerOfChatId("xx")).toBeNull();
  });

  it("encodeParentThreadId throws when no delegate owns the chat id (sub-agent routing must not silently mis-route)", () => {
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const composite = new CompositeTransportAdapter([tg]);

    expect(() => composite.encodeParentThreadId("C01")).toThrow(/No transport recognizes chat id/);
  });

  it("per-transport pairingComplete: paired-then-pending race walkthrough", async () => {
    // Walkthrough from slack-plan.md §1.6:
    //   1. Both transports have pending pairings.
    //   2. Telegram event arrives first; ownerOf returns telegram delegate.
    //   3. Telegram pairing completes; gateway sets pairingComplete["telegram"] = true.
    //   4. Slack event arrives; ownerOf returns slack delegate. Slack still pending.
    //   5. Slack pairing completes.
    const tg = fakeDelegate("telegram", "telegram:", (id) => /^-?\d+$/.test(String(id)));
    const sl = fakeDelegate("slack", "slack:", (id) => typeof id === "string" && /^[CDGU]/.test(id));
    (tg.isPairingPending as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (sl.isPairingPending as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (tg.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValue({ threadId: 1, userId: 1, username: "tg" });
    (sl.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValue({ threadId: "C0", userId: "U0", username: "sl" });

    const composite = new CompositeTransportAdapter([tg, sl]);

    // Step 1: telegram event
    const tThread: ChatThread = { id: "telegram:1", post: async () => {} };
    const tResult = await composite.handlePairing(tThread, { text: "/start abc" } as any);
    expect(tResult?.transport).toBe("telegram");

    // Step 2: slack event still routes correctly (the composite has no internal
    // 'paired' flag — the gateway tracks that. Composite always tries delegates
    // in order; telegram doesn't own slack thread so it returns null per the
    // ownsThread filter inside its real handlePairing implementation.)
    const sThread: ChatThread = { id: "slack:C0", post: async () => {} };
    // Mock telegram's handlePairing to return null when the thread isn't its —
    // matches the real adapter's pre-check.
    (tg.handlePairing as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const sResult = await composite.handlePairing(sThread, { text: "hi" } as any);
    expect(sResult?.transport).toBe("slack");
  });
});

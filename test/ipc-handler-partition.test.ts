/**
 * test/ipc-handler-partition.test.ts — IPC handler routing for mixed-transport chat ids.
 *
 * Verifies the regression flagged in slack-plan.md iter-2:
 *   - req.session = "Cxxx" (slack channel) routes single-target instead of
 *     falling through to "send to all" (which the old `/^-?\d+$/` regex did).
 *   - req.session = "12345" (numeric-as-string telegram) routes single-target.
 *   - Missing/unknown session fans out to all configured ids.
 */

import { describe, it, expect, vi } from "vitest";
import { createIpcHandler } from "../src/ipc/handler";
import type { TransportAdapter } from "../src/transports/types";
import type { GatewayConfig } from "../src/types";

function makeTransport(): { transport: TransportAdapter; notifyMock: ReturnType<typeof vi.fn> } {
  const notifyMock = vi.fn(async () => {});
  const transport: TransportAdapter = {
    name: "composite-stub",
    enrichPrompt: (_t, x) => x,
    postMessage: async () => {},
    postRich: async () => {},
    progress: async () => ({ update: async () => {} }),
    stream: async () => {},
    registerCommands: async () => {},
    ownsThread: () => true,
    ownsChatId: (id) => {
      const s = String(id);
      return /^-?\d+$/.test(s) || /^[CDGU]/.test(s);
    },
    encodeParentThreadId: (id) => `${id}:main`,
    formatNotifySession: () => "main",
    notify: notifyMock,
    createThread: (id) => ({ id: String(id), post: async () => {} }),
    isPairingPending: async () => false,
    handlePairing: async () => null,
  };
  return { transport, notifyMock };
}

function makeConfig(notifyChatIds: (string | number)[]): GatewayConfig {
  return {
    agent: { type: "noop" },
    chat: { botUsername: "test", adapters: { telegram: {} }, notifyChatIds },
  } as GatewayConfig;
}

describe("IPC handler — multi-transport notify partition", () => {
  it("routes a slack-shaped session string to a single target", async () => {
    const { transport, notifyMock } = makeTransport();
    const handler = createIpcHandler(transport, () => makeConfig([12345, "C01ABC", -678]));

    const res = await handler({ type: "notify", session: "C01ABC", text: "hi" });
    expect(res).toEqual({ ok: true });
    expect(notifyMock).toHaveBeenCalledWith(["C01ABC"], "hi");
  });

  it("routes a numeric-string session to a single target (telegram path)", async () => {
    const { transport, notifyMock } = makeTransport();
    const handler = createIpcHandler(transport, () => makeConfig([12345, "C01ABC"]));

    const res = await handler({ type: "notify", session: "12345", text: "hi" });
    expect(res).toEqual({ ok: true });
    expect(notifyMock).toHaveBeenCalledWith(["12345"], "hi");
  });

  it("falls back to all chat ids when session is missing", async () => {
    const { transport, notifyMock } = makeTransport();
    const all: (string | number)[] = [12345, "C01ABC", -678];
    const handler = createIpcHandler(transport, () => makeConfig(all));

    await handler({ type: "notify", text: "hi" });
    expect(notifyMock).toHaveBeenCalledWith(all, "hi");
  });

  it("'main' session targets the first configured chat id", async () => {
    const { transport, notifyMock } = makeTransport();
    const handler = createIpcHandler(transport, () => makeConfig([12345, "C01ABC"]));

    await handler({ type: "notify", session: "main", text: "hi" });
    expect(notifyMock).toHaveBeenCalledWith([12345], "hi");
  });

  it("falls back to all when session is an unrecognized id shape", async () => {
    const { transport, notifyMock } = makeTransport();
    const all: (string | number)[] = [12345, "C01ABC"];
    const handler = createIpcHandler(transport, () => makeConfig(all));

    await handler({ type: "notify", session: "garbage-shape", text: "hi" });
    expect(notifyMock).toHaveBeenCalledWith(all, "hi");
  });

  it("returns error when no notifyChatIds are configured", async () => {
    const { transport } = makeTransport();
    const handler = createIpcHandler(transport, () => makeConfig([]));

    const res = await handler({ type: "notify", text: "hi" });
    expect(res).toEqual({ ok: false, error: "No notifyChatIds configured" });
  });
});

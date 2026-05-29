/**
 * test/gateway-multi-transport.test.ts — Two transports, one Gateway.
 *
 * Covers the wiring around `buildTransportDelegates` (gateway.ts:71-83)
 * + `buildCompositeTransport`. We never call `Gateway.start()` (it'd
 * try to open a real Slack websocket / Telegram polling); we just
 * construct the gateway, then walk the composite via the same paths
 * `start()` uses internally.
 *
 * Risks closed:
 *  - Configuring both adapters doesn't crash the constructor.
 *  - The composite owns BOTH delegates and routes by ownsThread/ownsChatId.
 *  - notify partitions across both transports.
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway } from "../src/gateway/gateway";
import type { AgentRouter, GatewayConfig } from "../src/types";
import type { CompositeTransportAdapter } from "../src/transports/composite";

function makeRouter(): AgentRouter {
  return {
    resolve: () => ({ name: "noop" } as any),
    dispose: async () => {},
  };
}

function makeBothConfig(): GatewayConfig {
  return {
    agent: { type: "noop" },
    chat: {
      botUsername: "test",
      adapters: {
        telegram: { mode: "polling" },
        slack: { mode: "socket" },
      },
    },
  } as GatewayConfig;
}

interface InternalGateway {
  transport: CompositeTransportAdapter;
}

describe("Gateway with both telegram + slack configured", () => {
  it("constructs without throwing and exposes both delegates on the composite", () => {
    const gw = new Gateway(makeRouter(), makeBothConfig());
    const composite = (gw as unknown as InternalGateway).transport;
    const names = composite.delegates.map((d) => d.name).sort();
    expect(names).toEqual(["slack", "telegram"]);
  });

  it("composite.ownsChatId routes telegram numeric vs slack Cxxx correctly", () => {
    const gw = new Gateway(makeRouter(), makeBothConfig());
    const composite = (gw as unknown as InternalGateway).transport;

    expect(composite.ownerOfChatId(12345)?.name).toBe("telegram");
    expect(composite.ownerOfChatId(-100123)?.name).toBe("telegram");
    expect(composite.ownerOfChatId("12345")?.name).toBe("telegram");
    expect(composite.ownerOfChatId("C01ABC")?.name).toBe("slack");
    expect(composite.ownerOfChatId("D02DEF")?.name).toBe("slack");
    expect(composite.ownerOfChatId("U03USER")?.name).toBe("slack");
    // Garbage shape — neither delegate claims it.
    expect(composite.ownerOfChatId("garbage")).toBeNull();
  });

  it("composite.ownsThread routes by platform prefix (with platform-decorated threads)", () => {
    const gw = new Gateway(makeRouter(), makeBothConfig());
    const composite = (gw as unknown as InternalGateway).transport;

    // Telegram's ownsThread requires adapter.telegramFetch (defended at the
    // boundary — the SDK decorates real threads with this). Slack's ownsThread
    // is just the id prefix.
    const tgThread = {
      id: "telegram:42",
      adapter: { telegramFetch: async () => null },
      post: async () => {},
    } as any;
    const slThread = { id: "slack:C01:1712", post: async () => {} } as any;

    expect(composite.ownerOf(tgThread)?.name).toBe("telegram");
    expect(composite.ownerOf(slThread)?.name).toBe("slack");
  });

  it("notify partitions a heterogeneous chat-id list across both delegates", async () => {
    const gw = new Gateway(makeRouter(), makeBothConfig());
    const composite = (gw as unknown as InternalGateway).transport;

    // Spy on each delegate's notify so we can assert the partition without
    // hitting the network. The composite calls them directly.
    const tg = composite.delegates.find((d) => d.name === "telegram")!;
    const sl = composite.delegates.find((d) => d.name === "slack")!;
    const tgSpy = vi.spyOn(tg, "notify").mockResolvedValue(undefined);
    const slSpy = vi.spyOn(sl, "notify").mockResolvedValue(undefined);

    await composite.notify([12345, "C01ABC", -100, "U02XYZ", "garbage"], "hello");

    expect(tgSpy).toHaveBeenCalledWith([12345, -100], "hello");
    expect(slSpy).toHaveBeenCalledWith(["C01ABC", "U02XYZ"], "hello");
    // "garbage" was dropped (no owner) — neither delegate sees it.

    tgSpy.mockRestore();
    slSpy.mockRestore();
  });

  it("formatNotifySession routes labels through the correct transport", () => {
    const gw = new Gateway(makeRouter(), makeBothConfig());
    const composite = (gw as unknown as InternalGateway).transport;

    expect(composite.formatNotifySession(-100456)).toBe("group:-100456");   // telegram negative-id
    expect(composite.formatNotifySession(789)).toBe("main");                // telegram positive
    expect(composite.formatNotifySession("C01ABC")).toBe("channel:C01ABC"); // slack channel
    expect(composite.formatNotifySession("D01DM")).toBe("main");            // slack DM
  });
});

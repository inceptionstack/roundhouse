/**
 * test for Gateway.postCommandResult dispatcher.
 *
 * Contract:
 *   - void return  \u2192 no transport call (legacy path).
 *   - RichResponse \u2192 transport.postRich called exactly once.
 *   - postRich is trusted to never throw (adapter contract). If it does,
 *     the gateway propagates rather than silently swallowing.
 *
 * We don't boot a real chat client; we instantiate the Gateway and reach
 * into the private dispatcher method. That keeps the dispatcher's
 * contract pinned in a single tight test.
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway } from "../src/gateway/gateway";
import type { AgentRouter, GatewayConfig } from "../src/types";
import type { RichResponse } from "../src/transports";

function makeGateway(transport: any): Gateway {
  // Minimal AgentRouter \u2014 dispatcher never reaches the agent layer.
  const router: AgentRouter = {
    resolve: () => ({ name: "noop" } as any),
    dispose: async () => {},
  };
  const config: GatewayConfig = {
    agent: { type: "noop" },
    chat: { botUsername: "test", adapters: {} },
  } as GatewayConfig;
  const gw = new Gateway(router, config);
  // Replace the transport the constructor wired in. Private field; tested at the seam.
  (gw as unknown as { transport: any }).transport = transport;
  return gw;
}

describe("Gateway.postCommandResult", () => {
  const thread = { id: "t:1", post: vi.fn() } as unknown as any;

  it("does nothing when the result is void/undefined", async () => {
    const transport = { postRich: vi.fn(async () => {}) };
    const gw = makeGateway(transport);

    // Reach into the private method. Compiles in TS via cast.
    const fn = (gw as unknown as { postCommandResult: (t: any, r: any) => Promise<void> }).postCommandResult.bind(gw);
    await fn(thread, undefined);

    expect(transport.postRich).not.toHaveBeenCalled();
  });

  it("calls transport.postRich exactly once when result is a RichResponse", async () => {
    const transport = { postRich: vi.fn(async () => {}) };
    const gw = makeGateway(transport);
    const result: RichResponse = { text: "hello" };

    const fn = (gw as unknown as { postCommandResult: (t: any, r: any) => Promise<void> }).postCommandResult.bind(gw);
    await fn(thread, result);

    expect(transport.postRich).toHaveBeenCalledTimes(1);
    expect(transport.postRich.mock.calls[0][0]).toBe(thread);
    expect(transport.postRich.mock.calls[0][1]).toBe(result);
  });

  it("propagates if transport.postRich throws (adapter contract violation)", async () => {
    // postRich is documented to never throw — adapters MUST degrade
    // internally (TelegramAdapter does so via safePostText). The gateway
    // dispatcher trusts that contract and does NOT wrap the call in
    // try/catch. If an adapter ever does throw, the error surfaces as a
    // bug instead of being silently swallowed.
    const transport = { postRich: vi.fn(async () => { throw new Error("boom"); }) };
    const gw = makeGateway(transport);
    const post = vi.fn(async () => undefined);
    const thr = { id: "t:2", post } as unknown as any;
    const result: RichResponse = { text: "menu text" };

    const fn = (gw as unknown as { postCommandResult: (t: any, r: any) => Promise<void> }).postCommandResult.bind(gw);
    await expect(fn(thr, result)).rejects.toThrow("boom");
    // No fallback post on the thread — contract is the adapter's responsibility.
    expect(post).not.toHaveBeenCalled();
  });

  it("forwards the Promise of postRich (awaits it)", async () => {
    let resolved = false;
    const transport = {
      postRich: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      }),
    };
    const gw = makeGateway(transport);
    const fn = (gw as unknown as { postCommandResult: (t: any, r: any) => Promise<void> }).postCommandResult.bind(gw);

    await fn(thread, { text: "x" });
    expect(resolved).toBe(true);
  });
});

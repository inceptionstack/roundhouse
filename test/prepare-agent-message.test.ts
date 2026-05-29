/**
 * test/prepare-agent-message.test.ts — Pin Gateway.prepareAgentMessage's
 * enrichPrompt call shape. Regression test for a real bug introduced when
 * the TransportAdapter.enrichPrompt signature widened from (text) to
 * (thread, text): the gateway's call site was originally missed and would
 * silently set agentMessage.text = undefined for every turn.
 *
 * We exercise prepareAgentMessage via a TS-cast into the private method,
 * matching the post-command-result.test.ts pattern.
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway } from "../src/gateway/gateway";
import type { AgentRouter, GatewayConfig } from "../src/types";

function makeGateway(transport: any): Gateway {
  const router: AgentRouter = {
    resolve: () => ({ name: "noop" } as any),
    dispose: async () => {},
  };
  const config: GatewayConfig = {
    agent: { type: "noop" },
    chat: { botUsername: "test", adapters: {} },
  } as GatewayConfig;
  const gw = new Gateway(router, config);
  (gw as unknown as { transport: any }).transport = transport;
  return gw;
}

interface InternalGateway {
  prepareAgentMessage: (thread: any, agentThreadId: string, userText: string, rawAttachments: any[]) => Promise<{ text: string; attachments?: unknown[] } | null>;
}

describe("Gateway.prepareAgentMessage — enrichPrompt arity", () => {
  it("calls transport.enrichPrompt(thread, text), not (text)", async () => {
    const enrichPrompt = vi.fn((_t: any, text: string) => `${text} [hint]`);
    const transport = {
      enrichPrompt,
      // The composite-stub doesn't need ownsThread/etc here — gateway's
      // prepareAgentMessage only invokes enrichPrompt.
    };
    const gw = makeGateway(transport);
    const thread = { id: "telegram:42", post: async () => {} };

    const result = await (gw as unknown as InternalGateway).prepareAgentMessage(
      thread,
      "telegram:42",
      "hello",
      [],
    );

    expect(enrichPrompt).toHaveBeenCalledWith(thread, "hello");
    expect(result?.text).toBe("hello [hint]");
  });

  it("does not enrich when there's no text (attachment-only message)", async () => {
    const enrichPrompt = vi.fn((_t: any, text: string) => `${text} [hint]`);
    const transport = { enrichPrompt };
    const gw = makeGateway(transport);
    const thread = { id: "telegram:42", post: async () => {} };

    // No text + no attachments → returns null. We're more interested in
    // confirming enrichPrompt isn't invoked with undefined.
    const result = await (gw as unknown as InternalGateway).prepareAgentMessage(
      thread,
      "telegram:42",
      "",
      [],
    );

    expect(result).toBeNull();
    expect(enrichPrompt).not.toHaveBeenCalled();
  });
});

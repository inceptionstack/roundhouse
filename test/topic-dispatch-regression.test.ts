/**
 * Regression test for the topic-session "adapter loss" path.
 *
 * Scenario: user is on a named topic ("deploy"). When they send `/topic`,
 * the gateway must:
 *   1. compute agentThreadId via applyTopicOverride() \u2192 "topic:42:deploy"
 *      (string-only rewrite \u2014 the chat thread is preserved).
 *   2. dispatch the /topic descriptor through the live in-turn dispatcher.
 *   3. call transport.postRich(thread, result) on the SAME chat thread the
 *      chat SDK delivered \u2014 not a synthetic { id: "topic:..." } object.
 *
 * Failure mode this protects against: any future refactor that conflates
 * the agent-session id with the transport thread (e.g. by replacing
 * `thread` with `{ id: agentThreadId }` somewhere in dispatch) would
 * cause /topic to lose its menu. This test drives the actual dispatcher
 * method `Gateway.dispatchInTurnCommand`, which is what `handle()` calls
 * live.
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway } from "../src/gateway/gateway";
import { applyTopicOverride, setActiveTopic, TOPIC_ACTION_ID } from "../src/gateway/topic-command";
import type { AgentRouter, GatewayConfig } from "../src/types";
import type { CommandDescriptor } from "../src/gateway/command-registry";
import { isCommand, isCommandWithArgs } from "../src/gateway/helpers";

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

interface GatewayInternals {
  buildCommandDescriptors: (deps: {
    allowedUsers: string[];
    allowedUserIds: number[];
    verboseThreads: Set<string>;
    threadLocks: Map<string, Promise<void>>;
    abortControllers: Map<string, AbortController>;
  }) => CommandDescriptor[];
  /** Live in-turn dispatcher that handle() uses. Calling this directly is the closest we can get to driving the real handler without a Chat SDK. */
  dispatchInTurnCommand: (
    inTurnCommands: readonly CommandDescriptor[],
    matchers: { isCommand: (t: string, c: string) => boolean; isCommandWithArgs: (t: string, c: string) => boolean },
    thread: any, message: any, trimmed: string, agentThreadId: string,
  ) => Promise<boolean>;
}

function buildInTurn(gw: Gateway): { inTurn: CommandDescriptor[]; matchers: any } {
  const internals = gw as unknown as GatewayInternals;
  const all = internals.buildCommandDescriptors({
    allowedUsers: [], allowedUserIds: [], verboseThreads: new Set(),
    threadLocks: new Map(), abortControllers: new Map(),
  });
  const inTurn = all.filter(d => d.stage !== "pre-turn");
  const matchers = {
    isCommand: (t: string, c: string) => isCommand(t, c, "test"),
    isCommandWithArgs: (t: string, c: string) => isCommandWithArgs(t, c, "test"),
  };
  return { inTurn, matchers };
}

describe("gateway dispatch \u2014 topic-session adapter preservation (regression)", () => {
  it("/topic from inside a named-topic session reaches transport.postRich with the original transport thread (not synthetic)", async () => {
    const chatId = "42";
    setActiveTopic(chatId, "deploy");

    // Seed memory-state files so listTopics() returns the deploy topic.
    const { ROUNDHOUSE_DIR } = await import("../src/config");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
    const seeds = [join(stateDir, `topic_c${chatId}_cdeploy.json`)];
    mkdirSync(stateDir, { recursive: true });
    for (const f of seeds) writeFileSync(f, "{}");

    // Realistic shape of the chat-SDK-delivered Telegram thread.
    const telegramFetch = vi.fn(async () => ({ ok: true }));
    const transportThread = {
      id: `telegram:${chatId}`,
      platformThreadId: `telegram:${chatId}`,
      adapter: { telegramFetch },
      post: vi.fn(async () => undefined),
    };

    const postRich = vi.fn(async () => {});
    const transport = { postRich, progress: vi.fn() };
    const gw = makeGateway(transport);

    try {
      const { inTurn, matchers } = buildInTurn(gw);
      const internals = gw as unknown as GatewayInternals;

      // Mirror what handle() does: routing rewrites the agent id only.
      const agentThreadId = applyTopicOverride("main", transportThread);
      expect(agentThreadId).toBe(`topic:${chatId}:deploy`);

      // Drive the live dispatcher \u2014 same code path handle() uses.
      const handled = await internals.dispatchInTurnCommand(
        inTurn, matchers,
        transportThread, { text: "/topic" }, "/topic", agentThreadId,
      );
      expect(handled).toBe(true);

      // postRich was called exactly once.
      expect(postRich).toHaveBeenCalledTimes(1);

      // KEY INVARIANT: the thread argument is THE SAME object \u2014 not a
      // clone, not a synthetic { id: "topic:42:deploy" }. If anyone later
      // swaps `thread` for `{ id: agentThreadId }` inside the dispatcher,
      // this `.toBe()` (referential equality) fails.
      const [passedThread, passedResponse] = postRich.mock.calls[0];
      expect(passedThread).toBe(transportThread);

      // The response carries a menu, not a text-only fallback.
      expect(passedResponse.menu).toBeDefined();
      const labels = passedResponse.menu.sections[0].buttons.map((b: any) => b.label);
      expect(labels.some((l: string) => l.includes("main (default)"))).toBe(true);
      expect(labels.some((l: string) => l.includes("deploy"))).toBe(true);

      // Active button is selected.
      const deployBtn = passedResponse.menu.sections[0].buttons.find((b: any) => b.label.includes("deploy"));
      expect(deployBtn?.selected).toBe(true);

      // Action id wires back to topic_select.
      expect(passedResponse.menu.sections[0].buttons[0].actionId).toBe(TOPIC_ACTION_ID);
    } finally {
      setActiveTopic(chatId, "main");
      for (const f of seeds) { try { rmSync(f); } catch { /* ignore */ } }
    }
  });

  it("dispatcher returns false for unrecognized commands", async () => {
    const transport = { postRich: vi.fn(), progress: vi.fn() };
    const gw = makeGateway(transport);
    const { inTurn, matchers } = buildInTurn(gw);
    const internals = gw as unknown as GatewayInternals;
    const transportThread = { id: "telegram:99", post: vi.fn() };

    const handled = await internals.dispatchInTurnCommand(
      inTurn, matchers, transportThread, { text: "hi" }, "hi", "main",
    );
    expect(handled).toBe(false);
    expect(transport.postRich).not.toHaveBeenCalled();
  });
});

/**
 * Regression test for the topic-session "adapter loss" path.
 *
 * Scenario: user is on a named topic ("deploy"). When they send `/topic`,
 * the gateway must:
 *   1. compute agentThreadId via applyTopicOverride() \u2192 "topic:42:deploy"
 *      (string-only rewrite \u2014 the chat thread is preserved).
 *   2. find the /topic descriptor and call desc.invoke({ thread, ... }).
 *   3. call transport.postRich(thread, result) on the SAME chat thread the
 *      chat SDK delivered \u2014 not a synthetic { id: "topic:..." } object.
 *
 * Failure mode this protects against: any future refactor that conflates
 * the agent-session id with the transport thread (e.g. by replacing
 * `thread` with `{ id: agentThreadId }` somewhere in dispatch) would
 * cause /topic to lose its menu. This test wires up enough of the
 * gateway to detect that.
 */

import { describe, it, expect, vi } from "vitest";
import { Gateway } from "../src/gateway/gateway";
import { applyTopicOverride, setActiveTopic, TOPIC_ACTION_ID } from "../src/gateway/topic-command";
import type { AgentRouter, GatewayConfig } from "../src/types";
import type { CommandDescriptor } from "../src/gateway/command-registry";

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

/**
 * Exercise the same descriptor.invoke + postCommandResult chain used in
 * the live `handle()` dispatch loop. We can't easily pump a real Chat SDK
 * message through here, but we CAN reproduce the exact invoke-then-post
 * sequence \u2014 which is where the bug would actually manifest.
 */
async function dispatchTopicCommand(
  gw: Gateway,
  thread: any,
  message: any,
  text: string,
): Promise<void> {
  // buildCommandDescriptors is private; cast to reach it.
  type Internals = {
    buildCommandDescriptors: (deps: {
      allowedUsers: string[];
      allowedUserIds: number[];
      verboseThreads: Set<string>;
      threadLocks: Map<string, Promise<void>>;
      abortControllers: Map<string, AbortController>;
    }) => CommandDescriptor[];
    postCommandResult: (t: any, r: any) => Promise<void>;
  };
  const internals = gw as unknown as Internals;

  const descriptors = internals.buildCommandDescriptors({
    allowedUsers: [],
    allowedUserIds: [],
    verboseThreads: new Set(),
    threadLocks: new Map(),
    abortControllers: new Map(),
  });

  const topicDesc = descriptors.find(d => d.triggers.includes("/topic"));
  if (!topicDesc) throw new Error("no /topic descriptor");

  // Mirror the live dispatch: compute agentThreadId, then invoke, then post.
  const agentThreadId = applyTopicOverride("main", thread);
  const result = await topicDesc.invoke({ thread, message, text, agentThreadId });
  await internals.postCommandResult(thread, result);
}

describe("gateway dispatch \u2014 topic-session adapter preservation (regression)", () => {
  it("preserves the original transport thread through /topic dispatch from inside a named-topic session", async () => {
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
      await dispatchTopicCommand(gw, transportThread, { text: "/topic" }, "/topic");

      // 1) agentThreadId rewrite happened (the routing rule).
      expect(applyTopicOverride("main", transportThread)).toBe(`topic:${chatId}:deploy`);

      // 2) postRich was called exactly once.
      expect(postRich).toHaveBeenCalledTimes(1);

      // 3) The thread argument is THE SAME object \u2014 not a clone, not a
      //    synthetic { id: "topic:42:deploy" }. This is the core invariant.
      const [passedThread, passedResponse] = postRich.mock.calls[0];
      expect(passedThread).toBe(transportThread);

      // 4) The response carries a menu (not a text-only fallback).
      expect(passedResponse.menu).toBeDefined();
      const labels = passedResponse.menu.sections[0].buttons.map((b: any) => b.label);
      expect(labels.some((l: string) => l.includes("main (default)"))).toBe(true);
      expect(labels.some((l: string) => l.includes("deploy"))).toBe(true);

      // 5) Active button is selected.
      const deployBtn = passedResponse.menu.sections[0].buttons.find((b: any) => b.label.includes("deploy"));
      expect(deployBtn?.selected).toBe(true);

      // 6) Action id is the topic action.
      expect(passedResponse.menu.sections[0].buttons[0].actionId).toBe(TOPIC_ACTION_ID);
    } finally {
      setActiveTopic(chatId, "main");
      for (const f of seeds) { try { rmSync(f); } catch { /* ignore */ } }
    }
  });

  it("dispatches /topic action callbacks back through the same transport thread", async () => {
    const chatId = "43";
    setActiveTopic(chatId, "main"); // start clean

    const transportThread = {
      id: `telegram:${chatId}`,
      platformThreadId: `telegram:${chatId}`,
      adapter: { telegramFetch: vi.fn(async () => ({ ok: true })) },
      post: vi.fn(async () => undefined),
    };

    const postRich = vi.fn(async () => {});
    const transport = { postRich, progress: vi.fn() };
    const gw = makeGateway(transport);

    try {
      // Reach the action handler the same way gateway.start() does.
      type Internals = {
        buildCommandDescriptors: (deps: any) => CommandDescriptor[];
        postCommandResult: (t: any, r: any) => Promise<void>;
      };
      const internals = gw as unknown as Internals;
      const descriptors = internals.buildCommandDescriptors({
        allowedUsers: [], allowedUserIds: [], verboseThreads: new Set(),
        threadLocks: new Map(), abortControllers: new Map(),
      });
      const topicDesc = descriptors.find(d => d.triggers.includes("/topic"))!;
      const handler = topicDesc.actions![TOPIC_ACTION_ID];

      const result = await handler({ value: "deploy", thread: transportThread });
      await internals.postCommandResult(transportThread, result);

      expect(postRich).toHaveBeenCalledTimes(1);
      // The thread passed to postRich is the SDK-delivered thread, not synthetic.
      expect(postRich.mock.calls[0][0]).toBe(transportThread);
      // Active topic was switched.
      const { getActiveTopic } = await import("../src/gateway/topic-command");
      expect(getActiveTopic(chatId)).toBe("deploy");
    } finally {
      setActiveTopic(chatId, "main");
    }
  });
});

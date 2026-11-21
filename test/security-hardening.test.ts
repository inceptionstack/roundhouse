/**
 * test/security-hardening.test.ts — who may drive the agent, and how.
 *
 * The gateway hands every accepted message to an agent with shell tools, so
 * these cover the admission path as it is wired in Gateway.start():
 *  - a stranger is refused, never subscribed, and their text is not logged;
 *  - a button press is authorized like a message;
 *  - chat.dmOnly ignores groups;
 *  - an empty allowlist refuses everyone unless chat.allowAll is set;
 *  - /update can be switched off; /model cannot be pointed at a prototype key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRouter, GatewayConfig } from "../src/types";

// ── Fakes for everything Gateway.start() would otherwise open ─────────────

type Handler = (...args: any[]) => Promise<void> | void;
const wired: {
  dm?: Handler; mention?: Handler; subscribed?: Handler;
  actions: Map<string, Handler>;
} = { actions: new Map() };

vi.mock("chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat")>();
  class FakeChat {
    onDirectMessage(h: Handler) { wired.dm = h; }
    onNewMention(h: Handler) { wired.mention = h; }
    onSubscribedMessage(h: Handler) { wired.subscribed = h; }
    onAction(id: string, h: Handler) { wired.actions.set(id, h); }
    async initialize() {}
    async shutdown() {}
    getAdapter() { return undefined; }
  }
  return { ...actual, Chat: FakeChat };
});

vi.mock("../src/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transports")>();
  return { ...actual, buildChatSdkAdapters: async () => ({ telegram: {} }) };
});

vi.mock("../src/cron/scheduler", () => ({
  CronSchedulerService: class {
    async start() {}
    async stop() {}
    getStatus() { return { enabledCount: 0, jobCount: 0 }; }
  },
}));

vi.mock("../src/ipc", () => ({
  IpcServer: class { async start() {} stop() {} },
  createIpcHandler: () => () => {},
}));

vi.mock("../src/subagents", () => ({
  SubAgentOrchestratorImpl: class { onSpawn() {} },
  SubAgentWatcher: class { start() {} stop() {} },
}));

vi.mock("../src/gateway/persona-inject", () => ({
  loadPersona: () => {},
  injectPersonaSection: (t: string) => t,
}));

import { Gateway } from "../src/gateway/gateway";

const OWNER_ID = 111;

function tgMessage(from: { id: number; username?: string; first_name?: string }, text: string, chatType = "private", chatId: number = from.id) {
  return {
    text,
    author: {
      userId: String(from.id),
      userName: from.username ?? from.first_name ?? String(from.id), // as @chat-adapter/telegram builds it
      fullName: from.first_name ?? "",
    },
    chat: { id: chatId, type: chatType },
    raw: { from, chat: { id: chatId, type: chatType } },
    attachments: [],
  };
}

function tgThread(chatId: number) {
  return {
    id: `telegram:${chatId}`,
    subscribe: vi.fn(async () => {}),
    post: vi.fn(async () => {}),
    startTyping: vi.fn(async () => {}),
  };
}

async function startGateway(chat: Partial<GatewayConfig["chat"]>) {
  const prompts: string[] = [];
  const agent = {
    name: "fake",
    prompt: async (_t: string, m: { text: string }) => { prompts.push(m.text); return { text: "" }; },
    promptStream: undefined,
    dispose: async () => {},
  };
  const router: AgentRouter = { resolve: () => agent as any, dispose: async () => {} };
  const config = {
    agent: { type: "fake" },
    memory: { enabled: false },
    voice: { stt: { enabled: false } },
    chat: { botUsername: "rh_bot", adapters: { telegram: { mode: "polling" } }, bootTurn: false, ...chat },
  } as unknown as GatewayConfig;
  const gw = new Gateway(router, config);
  // Posting, pairing and typing go through the transport; stub what a turn touches.
  const transport = (gw as any).transport;
  transport.isPairingPending = async () => false;
  transport.registerCommands = async () => {};
  transport.notify = async () => {};
  transport.postMessage = vi.fn(async () => {});
  transport.postRich = vi.fn(async () => {});
  await gw.start();
  return { gw, prompts, transport };
}

describe("gateway admission", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    wired.dm = wired.mention = wired.subscribed = undefined;
    wired.actions.clear();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("runs the owner's message and subscribes the thread", async () => {
    const { prompts } = await startGateway({ allowedUsers: ["alice"], allowedUserIds: [OWNER_ID] });
    const thread = tgThread(OWNER_ID);
    await wired.dm!(thread, tgMessage({ id: OWNER_ID, username: "alice" }, "hello"));
    expect(thread.subscribe).toHaveBeenCalledTimes(1);
    expect(prompts.some((p) => p.includes("hello"))).toBe(true);
  });

  it("refuses a stranger: no prompt, no subscribe, message text not logged", async () => {
    const { prompts } = await startGateway({ allowedUsers: ["alice"], allowedUserIds: [OWNER_ID] });
    const thread = tgThread(666);
    await wired.dm!(thread, tgMessage({ id: 666, username: "mallory" }, "rm -rf ~ SECRET-MARKER"));
    await wired.mention!(thread, tgMessage({ id: 666, username: "mallory" }, "@rh_bot SECRET-MARKER"));
    expect(prompts).toEqual([]);
    expect(thread.subscribe).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("SECRET-MARKER");
  });

  it("refuses a no-username account whose first name is the owner's username, before pairing too", async () => {
    const { prompts } = await startGateway({ allowedUsers: ["alice"], allowedUserIds: [] });
    await wired.dm!(tgThread(666), tgMessage({ id: 666, first_name: "alice" }, "whoami"));
    expect(prompts).toEqual([]);
  });

  it("refuses everyone on an empty allowlist, and accepts with chat.allowAll", async () => {
    const closed = await startGateway({ allowedUsers: [], allowedUserIds: [] });
    await wired.dm!(tgThread(5), tgMessage({ id: 5, username: "anyone" }, "hi"));
    expect(closed.prompts).toEqual([]);

    const open = await startGateway({ allowedUsers: [], allowedUserIds: [], allowAll: true });
    await wired.dm!(tgThread(5), tgMessage({ id: 5, username: "anyone" }, "hi"));
    expect(open.prompts.length).toBe(1);
  });

  it("chat.dmOnly ignores the owner's messages in a group", async () => {
    const { prompts } = await startGateway({ allowedUserIds: [OWNER_ID], dmOnly: true });
    const group = tgThread(-100500);
    const msg = tgMessage({ id: OWNER_ID, username: "alice" }, "@rh_bot deploy", "supergroup", -100500);
    await wired.mention!(group, msg);
    await wired.subscribed!(group, msg);
    expect(prompts).toEqual([]);
    expect(group.subscribe).not.toHaveBeenCalled();
  });

  it("without dmOnly a group mention by the owner still works, and a member's does not", async () => {
    const { prompts } = await startGateway({ allowedUserIds: [OWNER_ID] });
    const group = tgThread(-100500);
    await wired.mention!(group, tgMessage({ id: 666, username: "mallory" }, "@rh_bot hi", "supergroup", -100500));
    expect(group.subscribe).not.toHaveBeenCalled();
    await wired.mention!(group, tgMessage({ id: OWNER_ID, username: "alice" }, "@rh_bot hi", "supergroup", -100500));
    expect(group.subscribe).toHaveBeenCalledTimes(1);
    expect(prompts.length).toBe(1);
  });

  it("ignores a button press from someone who is not allowed", async () => {
    const { transport } = await startGateway({ allowedUserIds: [OWNER_ID] });
    expect(wired.actions.size).toBeGreaterThan(0);
    for (const handler of wired.actions.values()) {
      await handler({ value: "__proto__", thread: tgThread(-100500), user: { userId: "666", userName: "mallory" } });
    }
    expect(transport.postRich).not.toHaveBeenCalled();
  });
});

describe("/update switch", () => {
  it("refuses when chat.allowUpdateCommand is false, without touching npm", async () => {
    const { handleUpdate } = await import("../src/gateway/commands");
    const posts: string[] = [];
    await handleUpdate({
      thread: { id: "telegram:1", post: async (t: string) => { posts.push(t); } },
      authorName: "alice",
      allowedUsers: [], allowedUserIds: [OWNER_ID],
      config: { chat: { allowUpdateCommand: false } },
      progress: async () => { throw new Error("update must not start"); },
      stopGateway: async () => { throw new Error("gateway must not stop"); },
    } as any);
    expect(posts.join("\n")).toMatch(/disabled on this host/);
  });
});

describe("/model choices", () => {
  it("offers the models pi has enabled on this host, not the built-in aliases", async () => {
    const { modelChoices } = await import("../src/gateway/model-command");
    const { aliases, order } = modelChoices({
      enabledModels: ["amazon-bedrock/us.anthropic.claude-opus-5-5", "amazon-bedrock/us.anthropic.claude-haiku-5-5", "openai/*"],
    });
    expect(order).toEqual(["opus-5-5", "haiku-5-5"]);
    expect(aliases["opus-5-5"]).toEqual({ provider: "amazon-bedrock", model: "us.anthropic.claude-opus-5-5", label: "claude-opus-5-5" });
  });

  it("falls back to the built-in aliases when pi has no enabledModels", async () => {
    const { modelChoices, MODEL_ALIASES } = await import("../src/gateway/model-command");
    expect(Object.keys(modelChoices({}).aliases).sort()).toEqual(Object.keys(MODEL_ALIASES).sort());
  });

  it("does not resolve prototype keys to a model", async () => {
    const { applyModelSelection } = await import("../src/gateway/model-command");
    for (const key of ["constructor", "__proto__", "tostring"]) {
      const settings: Record<string, any> = { defaultProvider: "p", defaultModel: "m" };
      const res = applyModelSelection(key, settings);
      expect(res.text).toMatch(/Unknown model/);
      expect(settings).toEqual({ defaultProvider: "p", defaultModel: "m" });
    }
  });
});

describe("sub-agent process tracking on this platform", () => {
  it("recognises this process as alive and rejects a wrong start marker", async () => {
    const { readSpawnClockTicks, isProcessAlive } = await import("../src/subagents/pid");
    const ticks = await readSpawnClockTicks(process.pid);
    expect(ticks.length).toBeGreaterThan(0);
    expect(await isProcessAlive(process.pid, ticks)).toBe(true);
    expect(await isProcessAlive(process.pid, "not-the-start-time")).toBe(false);
  });
});

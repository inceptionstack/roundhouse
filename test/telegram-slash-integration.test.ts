/**
 * test/telegram-slash-integration.test.ts — real Chat SDK + real Telegram adapter.
 *
 * Feeds raw Telegram updates through `adapter.processUpdate` into a started
 * Gateway. The other gateway tests call the registered handlers directly,
 * which cannot show a delivery the adapter never makes: since Chat SDK 4.3x a
 * message that starts with a bot command is raised as a slash-command event
 * and is no longer passed to the message handlers. With no slash handler
 * registered, /status, /cancel and the pairing /start vanish without a trace.
 *
 * No network: the adapter's initialize is replaced and fetch is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AgentRouter, GatewayConfig } from "../src/types";

let adapter: any;

vi.mock("../src/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transports")>();
  return { ...actual, buildChatSdkAdapters: async () => ({ telegram: adapter }) };
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

const OWNER = { id: 111, is_bot: false, first_name: "Al", username: "alice" };
const STRANGER = { id: 666, is_bot: false, first_name: "alice" }; // no @username, owner's name as first name

/** Telegram API calls the gateway made, as [method, body]. */
let apiCalls: Array<[string, any]>;

function update(id: number, from: typeof OWNER | typeof STRANGER, text: string) {
  const command = /^\/[A-Za-z0-9_@]+/.exec(text)?.[0];
  return {
    update_id: id,
    message: {
      message_id: id, date: 1_700_000_000,
      chat: { id: from.id, type: "private" }, from, text,
      // What a real Telegram client attaches to a message that starts with a command.
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command.length }] } : {}),
    },
  };
}

async function deliver(u: unknown) {
  await Promise.all([adapter.processUpdate(u, {})].flat());
  await new Promise((r) => setTimeout(r, 30));
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
  const gw = new Gateway(router, {
    agent: { type: "fake" },
    memory: { enabled: false },
    voice: { stt: { enabled: false } },
    chat: { botUsername: "rh_bot", adapters: { telegram: { mode: "polling" } }, bootTurn: false, ...chat },
  } as unknown as GatewayConfig);
  const transport = (gw as any).transport;
  transport.isPairingPending = async () => false;
  transport.registerCommands = async () => {};
  transport.notify = async () => {};
  await gw.start();
  return { prompts };
}

describe("Telegram slash commands through the real adapter", () => {
  beforeEach(() => {
    apiCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      const method = String(url).split("/").pop() ?? "";
      let body: any = {};
      try { body = init?.body ? JSON.parse(init.body) : {}; } catch { /* form data */ }
      apiCalls.push([method, body]);
      const result = method === "sendMessage" ? { message_id: 1, date: 1, chat: { id: body.chat_id, type: "private" } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adapter = createTelegramAdapter({ botToken: "123456:TEST-TOKEN-NOT-REAL", mode: "polling", userName: "rh_bot" } as any);
    // The real initialize asks Telegram who the bot is and starts polling.
    adapter.initialize = async (chat: unknown) => { adapter.chat = chat; };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const sentTo = (chatId: number) => apiCalls.filter(([m, b]) => m === "sendMessage" && String(b.chat_id) === String(chatId));

  it("the owner's /verbose is answered", async () => {
    const { prompts } = await startGateway({ allowedUserIds: [OWNER.id] });
    await deliver(update(1, OWNER, "/verbose"));
    expect(sentTo(OWNER.id).length).toBe(1);
    expect(JSON.stringify(sentTo(OWNER.id)[0][1])).toMatch(/verbose/i);
    expect(prompts).toEqual([]);
  });

  it("plain text and an unknown command both reach the agent", async () => {
    const { prompts } = await startGateway({ allowedUserIds: [OWNER.id] });
    await deliver(update(1, OWNER, "hello there"));
    await deliver(update(2, OWNER, "/skill deploy now"));
    expect(prompts.map((p) => p.split("\n")[0])).toEqual(["hello there", "/skill deploy now"]);
  });

  it("a stranger's commands get no answer and no agent turn, with ids paired or with names only", async () => {
    for (const chat of [{ allowedUserIds: [OWNER.id] }, { allowedUsers: ["alice"], allowedUserIds: [] }]) {
      apiCalls = [];
      const { prompts } = await startGateway(chat);
      for (const [i, text] of ["/status", "/doctor", "/crons", "/cancel", "/new", "run this"].entries()) {
        await deliver(update(100 + i, STRANGER, text));
      }
      expect(sentTo(STRANGER.id)).toEqual([]);
      expect(prompts).toEqual([]);
    }
  });
});

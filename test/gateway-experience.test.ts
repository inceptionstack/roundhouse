/**
 * test/gateway-experience.test.ts — what a conversation costs and how it ends.
 *
 *  - Persona and tool notes are sent once (system prompt) when the adapter
 *    can carry them, not in front of every message.
 *  - An edit to an old message does not run again as a new request.
 *  - Stopping the gateway interrupts turns and returns, even when the chat
 *    SDK's own shutdown never does.
 *  - The flush before a compaction uses the conversation model by default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRouter, GatewayConfig } from "../src/types";

type Handler = (...args: any[]) => Promise<void> | void;
const wired: { dm?: Handler; shutdown: () => Promise<void> } = { shutdown: async () => {} };

vi.mock("chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat")>();
  class FakeChat {
    onDirectMessage(h: Handler) { wired.dm = h; }
    onNewMention() {}
    onSubscribedMessage() {}
    onSlashCommand() {}
    onAction() {}
    async initialize() {}
    shutdown() { return wired.shutdown(); }
    getAdapter() { return undefined; }
  }
  return { ...actual, Chat: FakeChat };
});
vi.mock("../src/transports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transports")>();
  return { ...actual, buildChatSdkAdapters: async () => ({ telegram: {} }) };
});
vi.mock("../src/cron/scheduler", () => ({
  CronSchedulerService: class { async start() {} async stop() {} getStatus() { return { enabledCount: 0, jobCount: 0 }; } },
}));
vi.mock("../src/ipc", () => ({ IpcServer: class { async start() {} stop() {} }, createIpcHandler: () => () => {} }));
vi.mock("../src/subagents", () => ({
  SubAgentOrchestratorImpl: class { onSpawn() {} },
  SubAgentWatcher: class { start() {} stop() {} },
}));

import { Gateway } from "../src/gateway/gateway";

const OWNER = 111;
const thread = () => ({ id: `telegram:${OWNER}`, subscribe: async () => {}, post: vi.fn(async () => {}), startTyping: async () => {} });
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  text, threadId: `telegram:${OWNER}`, attachments: [],
  author: { userId: String(OWNER), userName: "alice" },
  raw: { from: { id: OWNER, username: "alice" }, chat: { id: OWNER, type: "private" }, ...extra },
});

async function startGateway(info: Record<string, unknown> = {}, agentExtra: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const disposed = vi.fn(async () => {});
  const agent = {
    name: "fake",
    prompt: async (_t: string, m: { text: string }) => { prompts.push(m.text); return { text: "" }; },
    promptStream: undefined,
    getInfo: () => info,
    dispose: async () => {},
    ...agentExtra,
  };
  const router: AgentRouter = { resolve: () => agent as any, dispose: disposed };
  const gw = new Gateway(router, {
    agent: { type: "fake" },
    memory: { enabled: false },
    voice: { stt: { enabled: false } },
    chat: { botUsername: "rh_bot", allowedUserIds: [OWNER], adapters: { telegram: { mode: "polling" } }, bootTurn: false },
  } as unknown as GatewayConfig);
  const transport = (gw as any).transport;
  transport.isPairingPending = async () => false;
  transport.registerCommands = async () => {};
  transport.notify = async () => {};
  transport.postMessage = async () => {};
  await gw.start();
  return { gw, prompts, disposed };
}

beforeEach(() => {
  wired.dm = undefined;
  wired.shutdown = async () => {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("standing context", () => {
  it("is repeated per message for an adapter that cannot carry it", async () => {
    const { prompts } = await startGateway();
    await wired.dm!(thread(), message("hello"));
    expect(prompts[0]).toContain("<persona>");
    expect(prompts[0]).toContain("<tools>");
  });

  it("is left out of the message when the adapter has it in its system prompt", async () => {
    const { prompts } = await startGateway({ standingContext: "system-prompt" });
    await wired.dm!(thread(), message("hello"));
    await wired.dm!(thread(), message("and again"));
    expect(prompts).toEqual(["hello", "and again"]);
  });

  it("buildStandingContext joins persona and tools and follows an edited tools.md", async () => {
    const { buildStandingContext } = await import("../src/gateway/standing-context");
    const { ROUNDHOUSE_DIR } = await import("../src/config");
    const first = buildStandingContext();
    expect(first).toMatch(/^<persona>[\s\S]*<\/persona>\n\n<tools>[\s\S]*<\/tools>$/);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(ROUNDHOUSE_DIR, { recursive: true });
    const toolsPath = join(ROUNDHOUSE_DIR, "tools.md");
    try {
      writeFileSync(toolsPath, "# Tools\nUSE-THE-BLUE-ONE </tools> trailing");
      utimesSync(toolsPath, new Date(), new Date(Date.now() + 5_000)); // a distinct mtime, whatever the clock resolution
      const edited = buildStandingContext();
      expect(edited).toContain("USE-THE-BLUE-ONE");
      // The block cannot be closed from inside.
      expect(edited.match(/<\/tools>/g)).toHaveLength(1);
    } finally {
      rmSync(toolsPath, { force: true });
    }
    expect(buildStandingContext()).not.toContain("USE-THE-BLUE-ONE");
  });
});

describe("edited messages", () => {
  it("an edit to an earlier message is not run as a new request", async () => {
    const { prompts } = await startGateway();
    const t = thread();
    await wired.dm!(t, message("deploy the thing"));
    await wired.dm!(t, message("deploy the thing (fixed typo)", { edit_date: 1_700_000_100 }));
    await wired.dm!(t, { ...message("another edit"), metadata: { edited: true } });
    expect(prompts.length).toBe(1);
    expect(t.post).not.toHaveBeenCalled();
  });
});

describe("stopping", () => {
  it("returns although the chat SDK never finishes shutting down, after ending the agent's work", async () => {
    vi.useFakeTimers();
    try {
      wired.shutdown = () => new Promise<void>(() => {}); // waits for a handler that never returns
      const { gw, disposed } = await startGateway();
      const controller = new AbortController();
      (gw as any).abortControllers.set("main", controller);

      let stopped = false;
      const stopping = gw.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;

      expect(stopped).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("flush before compaction", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function flush(config: Record<string, unknown> | undefined) {
    const { flushMemoryThenCompact } = await import("../src/memory/lifecycle");
    const calls: string[] = [];
    const agent = {
      name: "fake",
      prompt: async () => { calls.push("prompt"); return { text: "" }; },
      promptWithModel: async (_t: string, _m: unknown, model: string) => { calls.push(`promptWithModel:${model}`); return { text: "" }; },
      compact: async () => { calls.push("compact"); return { tokensBefore: 600_000, tokensAfter: 40_000 }; },
      compactWithModel: async (_t: string, model: string) => { calls.push(`compactWithModel:${model}`); return { tokensBefore: 600_000, tokensAfter: 40_000 }; },
      getInfo: () => ({ hasMemoryExtension: false }),
      dispose: async () => {},
    };
    const root = mkdtempSync(join(tmpdir(), "rh-flush-"));
    dirs.push(root);
    await flushMemoryThenCompact(`flush-test-${dirs.length}-${Date.now()}`, agent as any, root, "hard", config as any);
    return calls;
  }

  it("uses the conversation model unless a flush model is configured", async () => {
    expect(await flush(undefined)).toEqual(["prompt", "compact"]);
    expect(await flush({ compact: { flushModel: null } })).toEqual(["prompt", "compact"]);
  });

  it("uses the configured flush model for both steps", async () => {
    expect(await flush({ compact: { flushModel: "p/cheap" } })).toEqual(["promptWithModel:p/cheap", "compactWithModel:p/cheap"]);
  });
});

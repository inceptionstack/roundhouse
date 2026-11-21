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

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRouter, GatewayConfig } from "../src/types";

// Everything in this file that reads or writes "~/.roundhouse" gets a
// directory of its own. One test edits tools.md there; without this it would
// replace the real file on a machine that runs roundhouse.
const sandbox = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return { dir: mkdtempSync(join(tmpdir(), "rh-experience-")) };
});
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return { ...actual, ROUNDHOUSE_DIR: sandbox.dir, CONFIG_DIR: sandbox.dir };
});

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
afterAll(() => { rmSync(sandbox.dir, { recursive: true, force: true }); });

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

    expect(ROUNDHOUSE_DIR).toBe(sandbox.dir); // never the real ~/.roundhouse
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
  it("an edit to an earlier message is not run as a new request, nor as a command", async () => {
    const abort = vi.fn(async () => {});
    const { prompts } = await startGateway({}, { abort });
    const t = thread();
    await wired.dm!(t, message("deploy the thing"));
    await wired.dm!(t, message("deploy the thing (fixed typo)", { edit_date: 1_700_000_100 }));
    await wired.dm!(t, message("/cancel", { edit_date: 1_700_000_200 })); // a pre-turn command
    expect(prompts.length).toBe(1);
    expect(abort).not.toHaveBeenCalled();
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

describe("stopping: nothing new starts", () => {
  it("a message that arrives after stop() began does not start a turn", async () => {
    const { gw, prompts } = await startGateway();
    await gw.stop();
    await wired.dm!(thread(), message("too late"));
    expect(prompts).toEqual([]);
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

  it("asks the agent to save memory again only after the conversation has grown, and does not re-inject what it wrote", async () => {
    const { flushMemoryThenCompact, prepareMemoryForTurn } = await import("../src/memory/lifecycle");
    const { loadThreadMemoryState } = await import("../src/memory/state");
    const root = mkdtempSync(join(tmpdir(), "rh-soft-"));
    dirs.push(root);
    const threadId = `soft-test-${Date.now()}`;
    let tokens = 460_000;
    let flushes = 0;
    const agent = {
      name: "fake",
      // The flush turn: the agent writes its memory file.
      prompt: async () => { flushes++; writeFileSync(join(root, "MEMORY.md"), `# Memory\nfact ${flushes}\n`); return { text: "" }; },
      getInfo: () => ({ hasMemoryExtension: false, contextTokens: tokens, contextWindow: 1_000_000, model: "big/conv" }),
      dispose: async () => {},
    };
    const config = { compact: { cooldownMs: 0 } }; // growth, not time, is under test
    const soft = () => flushMemoryThenCompact(threadId, agent as any, root, "soft", config as any);
    // A conversation that has been going: memory files exist and were injected once.
    expect((await prepareMemoryForTurn(threadId, { text: "hello" }, agent as any, root, config as any)).injected).toBe(true);

    // Band on a 1M window: 450k to 600k, so a step is 50k.
    await soft();                       // first time in the band
    tokens = 480_000; await soft();     // +20k: not yet
    tokens = 505_000; await soft();     // +45k: not yet
    tokens = 512_000; await soft();     // +52k: again
    tokens = 100_000; await soft();     // shrank (compacted or /new): a new cycle
    expect(flushes).toBe(3);

    // What the agent just wrote counts as seen: the next turn does not get it prepended.
    const state = await loadThreadMemoryState(threadId);
    expect(state.lastSoftFlushTokens).toBe(100_000);
    const prepared = await prepareMemoryForTurn(threadId, { text: "next question" }, agent as any, root, config as any);
    expect(prepared.injected).toBe(false);
    expect(prepared.message.text).toBe("next question");
  });

  it("uses the configured flush model for both steps", async () => {
    expect(await flush({ compact: { flushModel: "p/cheap" } })).toEqual(["promptWithModel:p/cheap", "compactWithModel:p/cheap"]);
  });
});

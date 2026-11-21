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
  const dir = mkdtempSync(join(tmpdir(), "rh-experience-"));
  // pi's settings too: /model writes the default model there.
  process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
  return { dir };
});
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return { ...actual, ROUNDHOUSE_DIR: sandbox.dir, CONFIG_DIR: sandbox.dir };
});

type Handler = (...args: any[]) => Promise<void> | void;
const wired: {
  dm?: Handler; rawDm?: Handler; slash?: Handler; rawSlash?: Handler;
  actions: Map<string, Handler>;
  /** Runs inside chat.initialize(): messages that were waiting at the platform arrive here. */
  onInitialize?: () => Promise<void> | void;
  shutdown: () => Promise<void>;
} = { actions: new Map(), shutdown: async () => {} };

let currentGateway: { whenIdle(): Promise<void> } | undefined;
const threads = new Map<string, any>();

vi.mock("chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat")>();
  class FakeChat {
    // `dm` waits for the outcome; `rawDm` is the handler exactly as the SDK calls it.
    onDirectMessage(h: Handler) { wired.rawDm = h; wired.dm = async (...a: any[]) => { await h(...a); await currentGateway?.whenIdle(); }; }
    onNewMention() {}
    onSubscribedMessage() {}
    onSlashCommand(h: Handler) { wired.rawSlash = h; wired.slash = async (...a: any[]) => { await h(...a); await currentGateway?.whenIdle(); }; }
    thread(id: string) { return threads.get(id); }
    onAction(id: string, h: Handler) { wired.actions.set(id, h); }
    async initialize() { await wired.onInitialize?.(); }
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
const thread = () => {
  // `adapter.telegramFetch` is what marks a thread as Telegram's for the transport layer.
  const t = { id: `telegram:${OWNER}`, subscribe: async () => {}, post: vi.fn(async () => {}), startTyping: vi.fn(async () => {}), adapter: { telegramFetch: async () => ({}) } };
  threads.set(t.id, t);
  return t;
};
const slash = (command: string, text = "") => ({
  command, text, channel: { id: `telegram:${OWNER}` },
  user: { userId: String(OWNER), userName: "alice" },
  raw: { from: { id: OWNER, username: "alice" }, chat: { id: OWNER, type: "private" } },
});
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
  const posted: string[] = []; // what went out through the transport (markdown replies)
  transport.postMessage = async (_t: unknown, text: string) => { posted.push(text); };
  await gw.start();
  currentGateway = gw;
  return { gw, prompts, disposed, posted };
}

beforeEach(() => {
  wired.dm = undefined;
  wired.onInitialize = undefined;
  wired.actions.clear();
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
    // (The Telegram transport appends its one-line formatting hint; the point
    // is that neither block is there.)
    expect(prompts.map((p) => p.split("\n")[0])).toEqual(["hello", "and again"]);
    for (const p of prompts) {
      expect(p).not.toContain("<persona>");
      expect(p).not.toContain("<tools>");
    }
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

describe("staying responsive during a turn", () => {
  it("the handler returns at once, messages keep their order, and a command does not wait in line", async () => {
    const gate: Array<() => void> = [];
    const order: string[] = [];
    const abort = vi.fn(async () => {});
    const { prompts } = await startGateway({ standingContext: "system-prompt" }, {
      prompt: async (_t: string, m: { text: string }) => {
        order.push(`start:${m.text.split("\n")[0]}`);
        await new Promise<void>((r) => gate.push(r));
        order.push(`end:${m.text.split("\n")[0]}`);
        return { text: "" };
      },
      abort,
    });
    void prompts;
    const t = thread();

    // The SDK's polling loop waits for this handler; it must not wait for the turn.
    let returned = false;
    await Promise.resolve(wired.rawDm!(t, message("first"))).then(() => { returned = true; });
    expect(returned).toBe(true);
    await vi.waitFor(() => expect(order).toEqual(["start:first"]));

    await wired.rawDm!(t, message("second"));      // arrives while "first" runs
    await wired.rawSlash!(slash("/cancel"));        // a command: handled now, not after the queue
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["start:first"]);           // "second" is still waiting its turn

    gate.shift()!();
    await vi.waitFor(() => expect(order).toEqual(["start:first", "end:first", "start:second"]));
    gate.shift()!();
    await currentGateway!.whenIdle();
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("does not show a typing indicator again after the answer (Telegram cannot clear one)", async () => {
    await startGateway();
    const t = thread();
    await wired.dm!(t, message("hello"));
    await new Promise((r) => setTimeout(r, 20)); // the typing loop's cleanup is deferred
    // Every call is a real "typing" action on Telegram; none may carry the "clear" argument.
    expect(t.startTyping.mock.calls.every((c: unknown[]) => c[0] === undefined)).toBe(true);
    const callsAfterAnswer = t.startTyping.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(t.startTyping.mock.calls.length).toBe(callsAfterAnswer);
  });
});

describe("commands that act on the conversation", () => {
  it("/model switches the conversation the command was sent in", async () => {
    const setModel = vi.fn(async () => ({ applied: true }));
    await startGateway({}, { setModel });
    const t = thread();
    await wired.slash!(slash("/model", "provider-x/model-y"));
    expect(setModel.mock.calls[0].slice(0, 2)).toEqual(["main", "provider-x/model-y"]);
  });

  it("/think shows the level, sets one, and says so when the model lacks it", async () => {
    let level = "high";
    const thinkingLevel = vi.fn(async (_t: string, wanted?: string) => {
      if (wanted && ["off", "low", "high"].includes(wanted)) level = wanted;
      return { level, available: ["off", "low", "high"] };
    });
    const { posted: posts } = await startGateway({}, { thinkingLevel });
    thread();
    await wired.slash!(slash("/think"));
    await wired.slash!(slash("/think", "low"));
    await wired.slash!(slash("/think", "ultra"));
    expect(posts[0]).toMatch(/Thinking: \*high\*/);
    expect(posts[1]).toMatch(/set to \*low\*/);
    expect(posts[2]).toMatch(/not a level this model has/);
    expect(thinkingLevel).toHaveBeenNthCalledWith(2, "main", "low");
  });

  it("/new tells the agent to start over and marks memory for re-injection", async () => {
    const restart = vi.fn(async () => {});
    await startGateway({}, { restart });
    const t = thread();
    await wired.slash!(slash("/new"));
    expect(restart).toHaveBeenCalledWith("main");
    const { loadThreadMemoryState } = await import("../src/memory/state");
    expect((await loadThreadMemoryState("main")).forceInjectReason).toBe("new-session");
    expect(String(t.post.mock.calls.at(-1)![0])).toMatch(/New conversation started/);
  });
});

describe("a restart in the middle of a turn", () => {
  it("is reported once by the next gateway, with the request, and nothing is run again", async () => {
    let release!: () => void;
    const first = await startGateway({ standingContext: "system-prompt" }, {
      prompt: async () => { await new Promise<void>((r) => { release = r; }); return { text: "" }; },
    });
    const t = thread();
    await wired.rawDm!(t, message("migrate the database and restart the service"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await first.gw.stop();   // the service is restarted while the turn runs
    release();
    await first.gw.whenIdle();

    const second = await startGateway({ standingContext: "system-prompt" });
    const notices = t.post.mock.calls.map((c: unknown[]) => String(c[0])).filter((m) => m.includes("restarted before I finished"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("migrate the database and restart the service");
    expect(second.prompts).toEqual([]);          // not run again

    t.post.mockClear();
    await startGateway({ standingContext: "system-prompt" }); // a third start has nothing to report
    expect(t.post).not.toHaveBeenCalled();
  });

  it("a turn that finished leaves nothing to report", async () => {
    await startGateway({ standingContext: "system-prompt" });
    const t = thread();
    await wired.dm!(t, message("quick question"));
    t.post.mockClear();
    await startGateway({ standingContext: "system-prompt" });
    expect(t.post).not.toHaveBeenCalled();
  });
});

describe("requests the previous gateway did not finish", () => {
  const blockedAgent = () => {
    const gates: Array<() => void> = [];
    const started: string[] = [];
    return {
      gates, started,
      extra: {
        prompt: async (_t: string, m: { text: string }) => {
          started.push(m.text.split("\n")[0]);
          await new Promise<void>((r) => gates.push(r));
          return { text: "" };
        },
      },
    };
  };
  const notices = (t: { post: { mock: { calls: unknown[][] } } }) =>
    t.post.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("restarted before I finished"));

  it("a message that was waiting at Telegram and starts during start-up is not reported as interrupted", async () => {
    const agent = blockedAgent();
    const t = thread();
    // The message is delivered as soon as polling starts, i.e. inside initialize().
    wired.onInitialize = () => wired.rawDm!(t, message("deploy X"));
    const { gw } = await startGateway({ standingContext: "system-prompt" }, agent.extra);
    await vi.waitFor(() => expect(agent.started).toEqual(["deploy X"]));
    expect(notices(t)).toEqual([]);

    // And if this gateway now really is stopped mid-turn, the next one says so.
    wired.onInitialize = undefined;
    await gw.stop();
    agent.gates.shift()!();
    await gw.whenIdle();
    await startGateway({ standingContext: "system-prompt" });
    expect(notices(t)).toHaveLength(1);
  });

  it("a message that was accepted but still waiting its turn is reported too, in one notice", async () => {
    const agent = blockedAgent();
    const { gw } = await startGateway({ standingContext: "system-prompt" }, agent.extra);
    const t = thread();
    await wired.rawDm!(t, message("first request"));
    await vi.waitFor(() => expect(agent.started).toEqual(["first request"]));
    await wired.rawDm!(t, message("second request"));   // queued behind the first
    await gw.stop();
    agent.gates.shift()!();
    await gw.whenIdle();
    expect(agent.started).toEqual(["first request"]);     // the second never started

    await startGateway({ standingContext: "system-prompt" });
    const n = notices(t);
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("first request");
    expect(n[0]).toContain("second request");
    expect(n[0].indexOf("first request")).toBeLessThan(n[0].indexOf("second request"));
  });
});

describe("what waits its turn and what does not", () => {
  it("a command the gateway does not know, and /new, keep their place in line", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const restart = vi.fn(async () => { order.push("restart"); });
    await startGateway({ standingContext: "system-prompt" }, {
      prompt: async (_t: string, m: { text: string }) => {
        order.push(m.text.split("\n")[0]);
        await new Promise<void>((r) => gates.push(r));
        return { text: "" };
      },
      restart,
    });
    const t = thread();
    await wired.rawDm!(t, message("first"));
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    await wired.rawDm!(t, message("second"));
    await wired.rawSlash!(slash("/skill", "third"));  // a prompt for the agent, not a gateway command
    await wired.rawSlash!(slash("/new"));              // must not move "second" into the new conversation

    for (const expected of [["first", "second"], ["first", "second", "/skill third"]]) {
      gates.shift()!();
      await vi.waitFor(() => expect(order).toEqual(expected));
    }
    gates.shift()!();
    await currentGateway!.whenIdle();
    expect(order).toEqual(["first", "second", "/skill third", "restart"]);
  });

  it("/cancel stops the turn that is running, also before it has reached the model, and says when there is none", async () => {
    const abort = vi.fn(async () => {});
    const gates: Array<() => void> = [];
    const { prompts } = await startGateway({ standingContext: "system-prompt" }, {
      abort,
      // prepareMessage runs before the prompt: a turn can be cancelled while it waits here.
      prompt: async (_t: string, m: { text: string }) => { prompts.push(m.text); return { text: "" }; },
    });
    const t = thread();

    await wired.slash!(slash("/cancel"));
    expect(String(t.post.mock.calls.at(-1)![0])).toMatch(/Nothing is running/);

    // Hold the turn in preparation by making the transport's prompt enrichment wait.
    const transport = (currentGateway as any).transport;
    const realProgress = transport.progress;
    void realProgress;
    const sttGate = new Promise<void>((r) => gates.push(r));
    (currentGateway as any).enrichWithStt = async () => { await sttGate; };
    await wired.rawDm!(t, message("slow to prepare"));
    await vi.waitFor(() => expect((currentGateway as any).runningTurns.size).toBe(1));
    await wired.rawSlash!(slash("/cancel"));
    await vi.waitFor(() => expect(String(t.post.mock.calls.at(-1)![0])).toMatch(/^⏹️ Cancelled\.$/));
    gates.shift()!();
    await currentGateway!.whenIdle();
    expect(prompts).toEqual([]);                       // never reached the model
    expect(abort).toHaveBeenCalledWith("main");
  });

  it("a button press does not hold up the SDK while the agent is busy, and a failed deferred switch is reported", async () => {
    let settle!: (r: { applied: boolean; detail?: string }) => void;
    const setModel = vi.fn(async (_t: string, _m: string, onDeferred?: (r: { applied: boolean; detail?: string }) => void) => {
      settle = onDeferred!;
      return { applied: true, deferred: true };
    });
    const { posted } = await startGateway({ standingContext: "system-prompt" }, { setModel });
    const t = thread();
    const press = wired.actions.get("model_select")!;
    let returned = false;
    await Promise.resolve(press({ value: "opus", thread: t, threadId: t.id, user: { userId: String(OWNER), userName: "alice" }, raw: { from: { id: OWNER, username: "alice" } } }))
      .then(() => { returned = true; });
    expect(returned).toBe(true);
    await currentGateway!.whenIdle();
    expect(setModel).toHaveBeenCalledTimes(1);

    settle({ applied: false, detail: "it no longer fits" });
    await vi.waitFor(() => expect(posted.some((p) => /did not happen after all: it no longer fits/.test(p))).toBe(true));
  });
});

/**
 * test/pi-adapter-session.test.ts — what chat commands do to a pi session.
 *
 * The pi SDK is replaced by a small fake that records what it was asked:
 *  - /new starts an empty session, also across a gateway restart;
 *  - /model reaches the conversation that is already going;
 *  - /think reads and sets the thinking level;
 *  - an image attachment goes to the model as an image.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = {
  opened: [] as string[],                 // "continue:<dir>" | "create:<dir>"
  prompts: [] as Array<{ text: string; images: number; model: string }>,
  setModelCalls: [] as string[],
  contextTokens: 10_000 as number | null,
  messages: [] as unknown[],
  handler: undefined as undefined | ((event: { type: string }) => void),
  aborts: 0,
  holdPrompt: undefined as Promise<void> | undefined,
  models: {
    "big/conv": { provider: "big", id: "conv", contextWindow: 1_000_000 },
    "big/other": { provider: "big", id: "other", contextWindow: 1_000_000 },
    "small/tiny": { provider: "small", id: "tiny", contextWindow: 200_000 },
  } as Record<string, { provider: string; id: string; contextWindow: number }>,
  noAuth: new Set<string>(),
  failSetModel: "" as string,
};

vi.mock("@earendil-works/pi-coding-agent", () => {
  let counter = 0;
  class FakeSession {
    agent = { state: { model: sdk.models["big/conv"], thinkingLevel: "high" } };
    isIdle = true;
    constructor(readonly sessionFile: string) {}
    get messages() { return sdk.messages; }
    get model() { return this.agent.state.model; }
    get thinkingLevel() { return this.agent.state.thinkingLevel; }
    subscribe(handler: (event: { type: string }) => void) { sdk.handler = handler; return () => {}; }
    async prompt(text: string, options?: { images?: unknown[] }) {
      sdk.prompts.push({ text, images: options?.images?.length ?? 0, model: `${this.model.provider}/${this.model.id}` });
      // pi writes the transcript as soon as the user message is appended,
      // long before the turn ends.
      writeFileSync(this.sessionFile, "{}\n");
      if (sdk.holdPrompt) await sdk.holdPrompt;
    }
    async waitForIdle() {}
    async reload() {}
    async setModel(model: { provider: string; id: string }) {
      if (sdk.failSetModel) throw new Error(sdk.failSetModel);
      sdk.setModelCalls.push(`${model.provider}/${model.id}`);
      this.agent.state.model = model as any;
      this.agent.state.thinkingLevel = "medium"; // pi resets it to the default for the new model
    }
    getAvailableThinkingLevels() { return ["off", "low", "medium", "high"]; }
    setThinkingLevel(level: string) { this.agent.state.thinkingLevel = level; }
    getSessionStats() { return { cost: 1.2345, tokens: { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 3000, total: 54_200 } }; }
    getContextUsage() { return { tokens: sdk.contextTokens, contextWindow: this.model.contextWindow, percent: null }; }
    async abort() { sdk.aborts++; }
    abortCompaction() {}
    dispose() {}
  }
  const manager = (kind: string, dir: string) => {
    sdk.opened.push(`${kind}:${dir.split("/").pop()}`);
    const file = join(dir, `session-${++counter}.jsonl`);
    return { getSessionFile: () => file };
  };
  return {
    createAgentSession: async (o: { sessionManager: { getSessionFile(): string } }) => ({
      session: new FakeSession(o.sessionManager.getSessionFile()),
      extensionsResult: { extensions: [], errors: [] },
    }),
    DefaultResourceLoader: class { async reload() {} },
    detectSupportedImageMimeTypeFromFile: async (path: string) => (path.endsWith(".png") ? "image/png" : null),
    getAgentDir: () => "/dev/null/agent",
    SettingsManager: { create: () => ({}) },
    SessionManager: {
      continueRecent: (_cwd: string, dir: string) => manager("continue", dir),
      create: (_cwd: string, dir: string) => manager("create", dir),
      open: (_file: string, dir: string) => manager("open", dir),
    },
    ModelRuntime: {
      create: async () => ({
        getModel: (p: string, id: string) => sdk.models[`${p}/${id}`],
        hasConfiguredAuth: (provider: string) => !sdk.noAuth.has(provider),
      }),
    },
  };
});

import { createPiAgentAdapter } from "../src/agents/pi/pi-adapter";

let dir: string;
let adapter: any;
const make = () => { adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir }); return adapter; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-pi-session-"));
  sdk.opened = []; sdk.prompts = []; sdk.setModelCalls = []; sdk.contextTokens = 10_000; sdk.messages = []; sdk.handler = undefined; sdk.aborts = 0; sdk.holdPrompt = undefined; sdk.noAuth.clear(); sdk.failSetModel = "";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await adapter?.dispose();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("/new", () => {
  it("starts an empty session instead of reopening the transcript it just closed", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    await adapter.restart("main");
    await adapter.prompt("main", { text: "two" });
    expect(sdk.opened).toEqual(["continue:main", "create:main"]);
    // Once the new session has a turn on disk the marker is gone, and later
    // sessions for this thread resume it like any other.
    expect(readdirSync(join(dir, "main")).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("still starts empty when the gateway restarts between /new and the next message", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    await adapter.restart("main");
    await adapter.dispose();

    make(); // a new process
    expect(existsSync(join(dir, "main", ".new-session"))).toBe(true);
    await adapter.prompt("main", { text: "two" });
    expect(sdk.opened).toEqual(["continue:main", "create:main"]);

    await adapter.dispose();
    make(); // and again: now there is nothing left to say "start fresh"
    await adapter.prompt("main", { text: "three" });
    expect(sdk.opened.at(-1)).toBe("continue:main");
  });
});

describe("/new, then a restart in the middle of its first turn", () => {
  it("resumes the conversation that was begun instead of starting another empty one", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    await adapter.restart("main");

    sdk.holdPrompt = new Promise<void>(() => {}); // the turn never finishes: the gateway dies
    void adapter.prompt("main", { text: "do X" }).catch(() => {});
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(2));
    expect(sdk.opened).toEqual(["continue:main", "create:main"]);
    sdk.holdPrompt = undefined;

    make(); // the next gateway; the owner says "continue"
    await adapter.prompt("main", { text: "continue" });
    expect(sdk.opened).toEqual(["continue:main", "create:main", "continue:main"]);
    expect(existsSync(join(dir, "main", ".new-session"))).toBe(false);
  });
});

describe("/model", () => {
  it("switches the conversation that is already going", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    expect(await adapter.setModel("main", "big/other")).toEqual({ applied: true });
    await adapter.prompt("main", { text: "two" });
    expect(sdk.prompts.map((p) => p.model)).toEqual(["big/conv", "big/other"]);
  });

  it("says why when it cannot: unknown model, no credentials, or a window the conversation has outgrown", async () => {
    make();
    await adapter.prompt("main", { text: "one" });

    expect(await adapter.setModel("main", "nope/none")).toMatchObject({ applied: false, detail: expect.stringMatching(/does not know/) });

    // Unknown, or no credentials: unusable here at all, so not a default either.
    expect((await adapter.setModel("main", "nope/none")).usable).toBe(false);
    sdk.noAuth.add("big");
    expect(await adapter.setModel("main", "big/other")).toMatchObject({ applied: false, usable: false, detail: expect.stringMatching(/no credentials for big/) });
    sdk.noAuth.clear();

    sdk.contextTokens = 450_000;
    expect(await adapter.setModel("main", "small/tiny")).toMatchObject({ applied: false, detail: expect.stringMatching(/does not fit its 200K window/) });
    expect(sdk.setModelCalls).toEqual([]);
  });

  it("answers at once while a turn is running, and switches when the turn ends", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    const turn = adapter.prompt("main", { text: "long turn" });
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));

    expect(await adapter.setModel("main", "big/other")).toEqual({ applied: true, deferred: true });
    expect(sdk.setModelCalls).toEqual([]); // not in the middle of the turn

    release();
    await turn;
    await vi.waitFor(() => expect(sdk.setModelCalls).toEqual(["big/other"]));
  });
});

describe("/model while a turn is running", () => {
  const busy = async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    const turn = adapter.prompt("main", { text: "long turn" });
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));
    return { turn, release };
  };

  it("refuses at once what it already knows cannot work, instead of promising a switch", async () => {
    const { turn, release } = await busy();
    sdk.contextTokens = 450_000;
    expect(await adapter.setModel("main", "small/tiny")).toMatchObject({ applied: false, detail: expect.stringMatching(/does not fit/) });
    release(); await turn;
    expect(sdk.setModelCalls).toEqual([]);
  });

  it("reports a deferred switch that failed when it was finally tried", async () => {
    const { turn, release } = await busy();
    sdk.failSetModel = "provider said no";
    const outcomes: unknown[] = [];
    expect(await adapter.setModel("main", "big/other", (r: unknown) => outcomes.push(r))).toEqual({ applied: true, deferred: true });
    release(); await turn;
    await vi.waitFor(() => expect(outcomes).toEqual([{ applied: false, detail: "provider said no" }]));
  });

  it("keeps the conversation's thinking level across the switch", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    await adapter.thinkingLevel("main", "high");
    await adapter.setModel("main", "big/other");
    expect((await adapter.thinkingLevel("main")).level).toBe("high");
  });

  it("/think answers during a turn and applies the change after it", async () => {
    const { turn, release } = await busy();
    expect(await adapter.thinkingLevel("main")).toMatchObject({ level: "high" });
    expect(await adapter.thinkingLevel("main", "low")).toMatchObject({ level: "low", deferred: true });
    release(); await turn;
    await vi.waitFor(async () => expect((await adapter.thinkingLevel("main")).level).toBe("low"));
  });
});

describe("/think and /status data", () => {
  it("reads the level, sets a level the model has, and refuses one it does not", async () => {
    make();
    expect(await adapter.thinkingLevel("main")).toEqual({ level: "high", available: ["off", "low", "medium", "high"] });
    expect((await adapter.thinkingLevel("main", "low")).level).toBe("low");
    expect((await adapter.thinkingLevel("main", "ultra")).level).toBe("low");
  });

  it("reports what the conversation has cost and its thinking level", async () => {
    make();
    await adapter.prompt("main", { text: "one" });
    expect(adapter.getInfo("main")).toMatchObject({
      thinkingLevel: "high",
      sessionCost: 1.2345,
      sessionTokens: { input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 3000 },
    });
    expect(adapter.getInfo("no-such-thread").sessionCost).toBeUndefined();
  });
});

describe("image attachments", () => {
  const attachment = (name: string) => {
    const localPath = join(dir, name);
    writeFileSync(localPath, "bytes");
    return { id: `att_${name}`, mediaType: "file" as const, name, localPath, mime: "application/octet-stream", sizeBytes: 5, untrusted: true as const };
  };

  it("go to the model as images, whatever Telegram called them, and the manifest says so", async () => {
    make();
    await adapter.prompt("main", { text: "what is this?", attachments: [attachment("shot.png"), attachment("notes.txt")] });
    const sent = sdk.prompts.at(-1)!;
    expect(sent.images).toBe(1);
    expect(sent.text).toContain('"attachedAsImage": true');
    expect(sent.text).toContain("were also sent with this message as images");
    // The text file is still described, and not as an image.
    expect(sent.text.match(/attachedAsImage/g)).toHaveLength(2); // one entry + the sentence
  });

  it("a message without images is sent as before", async () => {
    make();
    await adapter.prompt("main", { text: "see file", attachments: [attachment("notes.txt")] });
    expect(sdk.prompts.at(-1)).toMatchObject({ images: 0 });
    expect(sdk.prompts.at(-1)!.text).not.toContain("attachedAsImage");
  });

  it("passes at most five images; the rest stay as files", async () => {
    make();
    const many = Array.from({ length: 7 }, (_, i) => attachment(`p${i}.png`));
    await adapter.prompt("main", { text: "album", attachments: many });
    expect(sdk.prompts.at(-1)!.images).toBe(5);
  });
});

describe("describeTurn (what /stop gives the reviewer)", () => {
  it("describes the turn while it is still running, without waiting for it", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    sdk.messages = [
      { role: "user", content: "restart the AP", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" },
    ];
    const turn = adapter.prompt("main", { text: "restart the AP" });
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));

    // The prompt holds the thread's queue; asking for the turn must not queue behind it.
    const described = await Promise.race([
      adapter.describeTurn("main", { maxChars: 10_000 }),
      new Promise((r) => setTimeout(() => r("waited for the turn"), 500)),
    ]) as any;
    expect(described).not.toBe("waited for the turn");
    expect(described.request).toBe("restart the AP");
    expect(described.toolCalls).toBe(1);
    expect(described.text).toContain("ASSISTANT CALLED bash");
    expect(described.sessionFile).toMatch(/session-\d+\.jsonl$/);

    release();
    await turn;
  });

  it("says the request is not in the conversation yet while the prompt is still getting ready, then that it is", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    sdk.messages = [{ role: "user", content: "an earlier request", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];
    const stream = adapter.promptStream("main", { text: "the new request" })[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));

    const getting = await adapter.describeTurn("main");
    expect(getting.request).toBe("an earlier request");
    expect(getting.reached).toBe(false);

    sdk.messages = [...sdk.messages, { role: "user", content: "the new request", timestamp: Date.now() + 5 }];
    const there = await adapter.describeTurn("main");
    expect(there.request).toBe("the new request");
    expect(there.reached).toBe(true);
    expect(there.requestAt).toBeGreaterThan(getting.requestAt);

    release();
    await first.catch(() => {});
    await stream.return?.();
  });

  it("counts a turn as asked for from the promptStream call itself, before its stream is even read", async () => {
    make();
    await adapter.prompt("main", { text: "first" }); // the conversation exists
    sdk.messages = [
      { role: "user", content: "first", timestamp: Date.now() - 60_000 },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ];
    expect((await adapter.describeTurn("main")).reached).toBe(true);  // nothing newer has been asked for
    adapter.promptStream("main", { text: "second" });                  // asked for; nobody reads the stream yet
    const turn = await adapter.describeTurn("main");
    expect(turn.request).toBe("first");
    expect(turn.reached).toBe(false);                                  // "first" is not the turn that is running now
  });

  it("a turn still waiting behind a memory save has not reached the conversation: what is there is the turn before", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    const flush = adapter.prompt("main", { text: "Roundhouse maintenance: Before context compaction, update your durable memory files:" });
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));
    sdk.messages = [
      { role: "user", content: "the finished request", timestamp: Date.now() - 60_000 },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      { role: "user", content: "Roundhouse maintenance: Before context compaction, update your durable memory files:", timestamp: Date.now() },
    ];
    const startedCancelled = vi.fn();
    const stream = adapter.promptStream("main", { text: "the next request" }, { onStart: startedCancelled })[Symbol.asyncIterator]();
    const first = stream.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.prompts.length).toBe(1); // still queued behind the memory save

    const turn = await adapter.describeTurn("main");
    expect(turn.request).toBe("the finished request");
    expect(turn.reached).toBe(false);

    // The owner stops it now. The memory save is what is running; the request
    // that waited behind it must not start once the save is out of the way.
    await adapter.abort("main");
    release();
    await flush;
    const seen: string[] = [];
    for (let r = await first; !r.done; r = await stream.next()) seen.push(r.value.type);
    expect(seen).toEqual(["agent_end"]);            // the stream ends, having done nothing
    expect(sdk.prompts.map((p) => p.text)).toEqual([expect.stringContaining("Roundhouse maintenance")]); // never sent to the model
    expect(startedCancelled).not.toHaveBeenCalled(); // and the caller is not told it was

    // What is asked for after the stop runs as usual, and says when the agent has it.
    sdk.holdPrompt = undefined;
    const promptsWhenTold: number[] = [];
    const next = adapter.promptStream("main", { text: "the request after it" }, { onStart: () => promptsWhenTold.push(sdk.prompts.length) })[Symbol.asyncIterator]();
    for (let r = await next.next(); !r.done; r = await next.next()) { /* drain */ }
    expect(sdk.prompts.at(-1)!.text).toBe("the request after it");
    expect(promptsWhenTold).toEqual([1]);           // once, just before the session got it
    expect(adapter.getInfo().reportsPromptStart).toBe(true);
  });

  it("a run that begins although its thread was stopped while the prompt was being handed over is stopped as it starts", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    const stream = adapter.promptStream("main", { text: "never mind" })[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1)); // inside session.prompt(), before the run exists
    await adapter.abort("main");                                 // finds nothing running to stop
    expect(sdk.aborts).toBe(1);
    sdk.handler!({ type: "agent_start" });                       // the run begins after all
    expect(sdk.aborts).toBe(2);

    release();
    for (let r = await first; !r.done; r = await stream.next()) { /* drain */ }

    // A run of a prompt that nobody stopped is left alone.
    sdk.holdPrompt = undefined;
    const ok = adapter.promptStream("main", { text: "carry on" })[Symbol.asyncIterator]();
    const okFirst = ok.next();
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(2));
    sdk.handler!({ type: "agent_start" });
    expect(sdk.aborts).toBe(2);
    for (let r = await okFirst; !r.done; r = await ok.next()) { /* drain */ }
  });

  it("a stop that comes while the conversation is still being opened cancels the request too", async () => {
    make();
    const stream = adapter.promptStream("fresh", { text: "never mind" })[Symbol.asyncIterator]();
    const first = stream.next();
    await adapter.abort("fresh"); // there is no session to abort yet: it is being created
    const seen: string[] = [];
    for (let r = await first; !r.done; r = await stream.next()) seen.push(r.value.type);
    expect(seen).toEqual(["agent_end"]);
    expect(sdk.prompts).toEqual([]);
  });

  it("a stop with nothing waiting does not cancel what is asked for afterwards", async () => {
    make();
    await adapter.abort("main");   // /cancel in an idle chat, before any conversation exists
    await adapter.abort("main");
    const stream = adapter.promptStream("main", { text: "hello" })[Symbol.asyncIterator]();
    for (let r = await stream.next(); !r.done; r = await stream.next()) { /* drain */ }
    expect(sdk.prompts.map((p) => p.text)).toEqual(["hello"]);
  });

  it("after a compaction that left no message of the owner's, a new turn is not taken for the old one's tail", async () => {
    make();
    let release!: () => void;
    sdk.holdPrompt = new Promise<void>((r) => { release = r; });
    sdk.messages = [
      { role: "compactionSummary", summary: "…", timestamp: Date.now() - 60_000 },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse" },
    ];
    const stream = adapter.promptStream("main", { text: "the new request" })[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(sdk.prompts.length).toBe(1));
    expect((await adapter.describeTurn("main")).reached).toBe(false);

    // The same shape, when the compaction happened inside the running turn: that is this turn.
    sdk.messages = [{ role: "compactionSummary", summary: "…", timestamp: Date.now() + 5 }, sdk.messages[1]];
    expect((await adapter.describeTurn("main")).reached).toBe(true);

    release();
    await first.catch(() => {});
    await stream.return?.();
  });

  it("is null for a thread with no conversation, and for one with no message from the owner", async () => {
    make();
    expect(await adapter.describeTurn("never-used")).toBeNull();
    await adapter.prompt("main", { text: "hello" });
    expect(await adapter.describeTurn("main")).toBeNull(); // the fake session has no messages
  });
});

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
    subscribe() { return () => {}; }
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
    async abort() {}
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
  sdk.opened = []; sdk.prompts = []; sdk.setModelCalls = []; sdk.contextTokens = 10_000; sdk.messages = []; sdk.holdPrompt = undefined; sdk.noAuth.clear(); sdk.failSetModel = "";
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

  it("is null for a thread with no conversation, and for one with no message from the owner", async () => {
    make();
    expect(await adapter.describeTurn("never-used")).toBeNull();
    await adapter.prompt("main", { text: "hello" });
    expect(await adapter.describeTurn("main")).toBeNull(); // the fake session has no messages
  });
});

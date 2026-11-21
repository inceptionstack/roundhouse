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
  holdPrompt: undefined as Promise<void> | undefined,
  models: {
    "big/conv": { provider: "big", id: "conv", contextWindow: 1_000_000 },
    "big/other": { provider: "big", id: "other", contextWindow: 1_000_000 },
    "small/tiny": { provider: "small", id: "tiny", contextWindow: 200_000 },
  } as Record<string, { provider: string; id: string; contextWindow: number }>,
  noAuth: new Set<string>(),
};

vi.mock("@earendil-works/pi-coding-agent", () => {
  let counter = 0;
  class FakeSession {
    agent = { state: { model: sdk.models["big/conv"], thinkingLevel: "high" } };
    isIdle = true;
    constructor(readonly sessionFile: string) {}
    get model() { return this.agent.state.model; }
    get thinkingLevel() { return this.agent.state.thinkingLevel; }
    subscribe() { return () => {}; }
    async prompt(text: string, options?: { images?: unknown[] }) {
      sdk.prompts.push({ text, images: options?.images?.length ?? 0, model: `${this.model.provider}/${this.model.id}` });
      if (sdk.holdPrompt) await sdk.holdPrompt;
      writeFileSync(this.sessionFile, "{}\n"); // pi persists the turn
    }
    async waitForIdle() {}
    async reload() {}
    async setModel(model: { provider: string; id: string }) {
      if (sdk.noAuth.has(model.provider)) throw new Error(`No API key for ${model.provider}/${model.id}`);
      sdk.setModelCalls.push(`${model.provider}/${model.id}`);
      this.agent.state.model = model as any;
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
        hasConfiguredAuth: () => true,
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
  sdk.opened = []; sdk.prompts = []; sdk.setModelCalls = []; sdk.contextTokens = 10_000; sdk.holdPrompt = undefined; sdk.noAuth.clear();
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

    sdk.noAuth.add("big");
    expect(await adapter.setModel("main", "big/other")).toMatchObject({ applied: false, detail: expect.stringMatching(/No API key/) });
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
    expect(sent.text).toContain("already in this message as images");
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

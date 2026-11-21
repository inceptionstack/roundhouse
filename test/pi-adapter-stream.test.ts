/**
 * test/pi-adapter-stream.test.ts — what the pi adapter tells the gateway.
 *
 * The pi SDK is replaced by a scripted session, so each case states the
 * events pi emits for one prompt and the stream the gateway should see:
 *  - an error pi recovers from by itself (retry, overflow compaction) is not
 *    reported; one it does not recover from is, once, when the run settles;
 *  - "still working" notices appear for follow-up runs, not for pi's own
 *    retry or compaction;
 *  - a flush/compaction model with a smaller window is skipped once the
 *    conversation has outgrown it;
 *  - persona and tool notes go into the system prompt, once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Ev = Record<string, any>;

/** What the scripted SDK saw and how it should behave next. */
const sdk = {
  /** Events each prompt() call emits, in order; one script per call. */
  scripts: [] as Ev[][],
  prompts: [] as Array<{ text: string; model: string }>,
  appended: [] as string[],        // extra system prompt blocks at session creation
  reloads: 0,
  contextTokens: 10_000 as number | null,
  models: {
    "big/conv": { provider: "big", id: "conv", contextWindow: 1_000_000 },
    "small/flush": { provider: "small", id: "flush", contextWindow: 200_000 },
  } as Record<string, { provider: string; id: string; contextWindow: number }>,
};

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeSession {
    private listeners = new Set<(e: Ev) => void>();
    agent = { state: { model: sdk.models["big/conv"], thinkingLevel: "high" } };
    isIdle = true;
    sessionFile = undefined;
    constructor(private loader?: { reload(): Promise<void> }) {}
    get model() { return this.agent.state.model; }
    subscribe(fn: (e: Ev) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    async prompt(text: string) {
      sdk.prompts.push({ text, model: `${this.model.provider}/${this.model.id}` });
      for (const ev of sdk.scripts.shift() ?? [{ type: "agent_start" }, { type: "agent_end", willRetry: false }, { type: "agent_settled", aborted: false }]) {
        for (const fn of this.listeners) fn(ev);
      }
    }
    async waitForIdle() {}
    async reload() { sdk.reloads++; await this.loader?.reload(); }
    async compact() { return { tokensBefore: 500_000, estimatedTokensAfter: 42_000, summary: "", firstKeptEntryId: "x" }; }
    getContextUsage() { return { tokens: sdk.contextTokens, contextWindow: this.model.contextWindow, percent: null }; }
    async abort() {}
    abortCompaction() {}
    dispose() {}
  }
  class DefaultResourceLoader {
    constructor(private opts: { appendSystemPromptOverride?: (base: string[]) => string[] }) {}
    async reload() { sdk.appended = this.opts.appendSystemPromptOverride?.([]) ?? []; }
  }
  const manager = { getSessionFile: () => "/dev/null/session.jsonl" };
  return {
    createAgentSession: async (o: { resourceLoader?: { reload(): Promise<void> } }) => ({
      session: new FakeSession(o.resourceLoader),
      extensionsResult: { extensions: [], errors: [] },
    }),
    DefaultResourceLoader,
    getAgentDir: () => "/dev/null/agent",
    SettingsManager: { create: () => ({}) },
    SessionManager: { continueRecent: () => manager, create: () => manager, open: () => manager },
    ModelRuntime: {
      create: async () => ({
        getModel: (p: string, id: string) => sdk.models[`${p}/${id}`],
        hasConfiguredAuth: () => true,
      }),
    },
  };
});

import { createPiAgentAdapter } from "../src/agents/pi/pi-adapter";

const assistant = (o: Ev) => ({ type: "message_end", message: { role: "assistant", ...o } });
const delta = (t: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } });
const ok = assistant({ stopReason: "stop" });
const failed = (m: string) => assistant({ stopReason: "error", errorMessage: m });
const start = { type: "agent_start" };
const end = (willRetry = false) => ({ type: "agent_end", willRetry });
const settled = { type: "agent_settled", aborted: false };

let dir: string;
let adapter: any;

async function stream(script: Ev[], config: Record<string, unknown> = {}) {
  adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir, ...config });
  sdk.scripts.push(script);
  const out: string[] = [];
  for await (const ev of adapter.promptStream("t", { text: "hi" })) {
    out.push(ev.type === "text_delta" ? `text:${ev.text}` : ev.type === "model_error" ? `error:${ev.message}` : ev.type);
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-pi-"));
  sdk.scripts = []; sdk.prompts = []; sdk.appended = []; sdk.reloads = 0; sdk.contextTokens = 10_000;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await adapter?.dispose();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pi adapter: provider errors", () => {
  it("does not report an error that pi retried successfully", async () => {
    const out = await stream([
      start, failed("overloaded"), end(true),
      { type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" },
      start, delta("ok"), ok, end(), settled,
    ]);
    expect(out).toEqual(["text:ok", "agent_end"]);
  });

  it("reports an error once, when the run settles with it", async () => {
    const out = await stream([start, failed("AccessDenied"), end(), settled]);
    expect(out).toEqual(["error:AccessDenied", "agent_end"]);
  });

  it("reports the last error when every retry failed", async () => {
    const out = await stream([
      start, failed("overloaded"), end(true),
      { type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" },
      start, failed("overloaded again"), end(), settled,
    ]);
    expect(out).toEqual(["error:overloaded again", "agent_end"]);
  });

  it("leaves a context overflow to pi when pi compacts and answers", async () => {
    const out = await stream([
      start, failed("prompt is too long: 1100000 tokens > 1000000 maximum"), end(),
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true },
      start, delta("answer"), ok, end(), settled,
    ]);
    // No error for roundhouse's own overflow recovery to act on, and no
    // "waiting for follow-up messages" notice for pi's retry.
    expect(out).toEqual(["text:answer", "agent_end"]);
  });

  it("still reports an overflow that pi's compaction did not fix", async () => {
    const overflow = "prompt is too long: 1100000 tokens > 1000000 maximum";
    const out = await stream([
      start, failed(overflow), end(),
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true },
      start, failed(overflow), end(), settled,
    ]);
    expect(out).toEqual([`error:${overflow}`, "agent_end"]);
  });
});

describe("pi adapter: still-working notices", () => {
  it("announces follow-up work queued by an extension, and its end", async () => {
    const out = await stream([
      start, delta("done"), ok, end(),
      start, delta("review reply"), ok, end(), settled,
    ]);
    expect(out).toEqual(["text:done", "draining", "text:review reply", "drain_complete", "agent_end"]);
  });

  it("stays quiet when the second run is pi continuing after a threshold compaction", async () => {
    const out = await stream([
      start, delta("part one"), ok, end(),
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
      start, delta(" part two"), ok, end(), settled,
    ]);
    expect(out).toEqual(["text:part one", "text: part two", "agent_end"]);
  });
});

describe("pi adapter: flush and compaction model", () => {
  it("uses the flush model while the conversation fits in its window", async () => {
    adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir });
    sdk.contextTokens = 120_000;
    await adapter.promptWithModel("t", { text: "save memory" }, "small/flush");
    expect(sdk.prompts.at(-1)).toEqual({ text: "save memory", model: "small/flush" });
    // The conversation model is back afterwards.
    await adapter.prompt("t", { text: "next" });
    expect(sdk.prompts.at(-1)!.model).toBe("big/conv");
  });

  it("keeps the conversation model once the conversation has outgrown the flush model", async () => {
    adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir });
    await adapter.prompt("t", { text: "first" }); // session exists, usage known
    sdk.contextTokens = 450_000;                  // more than a 200k model can read
    await adapter.promptWithModel("t", { text: "save memory" }, "small/flush");
    expect(sdk.prompts.at(-1)).toEqual({ text: "save memory", model: "big/conv" });
  });

  it("reports pi's estimate of the size after compaction when no live count exists yet", async () => {
    adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir });
    await adapter.prompt("t", { text: "first" });
    sdk.contextTokens = null; // pi has no count until the next response
    expect(await adapter.compact("t")).toEqual({ tokensBefore: 500_000, tokensAfter: 42_000 });
  });
});

describe("pi adapter: standing context", () => {
  it("puts it in the system prompt, says so, and rebuilds the prompt when it changes", async () => {
    let text = "<persona>\nv1\n</persona>";
    adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir, standingContext: () => text });
    expect(adapter.getInfo().standingContext).toBe("system-prompt");

    await adapter.prompt("t", { text: "one" });
    expect(sdk.appended).toEqual(["<persona>\nv1\n</persona>"]);
    expect(sdk.prompts.at(-1)!.text).toBe("one"); // the user message carries none of it
    expect(sdk.reloads).toBe(0);

    await adapter.prompt("t", { text: "two" });
    expect(sdk.reloads).toBe(0); // unchanged: no rebuild, the prompt cache stays valid

    text = "<persona>\nv2\n</persona>";
    await adapter.prompt("t", { text: "three" });
    expect(sdk.reloads).toBe(1);
    expect(sdk.appended).toEqual(["<persona>\nv2\n</persona>"]);
  });

  it("does not claim it without a standing context (cron runs, roundhouse agent)", async () => {
    adapter = createPiAgentAdapter({ cwd: dir, sessionDir: dir });
    expect(adapter.getInfo().standingContext).toBeUndefined();
  });
});

/**
 * test/turn-transcript.test.ts — a turn of the conversation as text for a reviewer (/stop).
 */

import { describe, it, expect } from "vitest";
import { renderTurn, clip, stripInjected } from "../src/agents/pi/turn-transcript";

const user = (text: string, timestamp = 1_700_000_000_000) => ({ role: "user", content: text, timestamp });
const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1_700_000_001_000 });
const calls = (name: string, args: Record<string, unknown>, id = "c1") => ({
  role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 1_700_000_002_000,
});
const result = (id: string, text: string, isError = false, toolName?: string) => ({
  role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError, timestamp: 1_700_000_003_000,
});

describe("renderTurn", () => {
  it("is null when there is no message from the owner", () => {
    expect(renderTurn([])).toBeNull();
    expect(renderTurn([said("hello")])).toBeNull();
  });

  it("covers the last request only: what came before it is another turn", () => {
    const t = renderTurn([user("old request"), said("old answer"), user("new request"), calls("bash", { command: "ls" }), result("c1", "a.txt")])!;
    expect(t.request).toBe("new request");
    expect(t.text).toContain("new request");
    expect(t.text).not.toContain("old request");
    expect(t.text).not.toContain("old answer");
  });

  it("lists what was said, which tool was called with what, and what came back, in order", () => {
    const t = renderTurn([
      user("restart the AP"),
      said("I will check the state first."),
      calls("bash", { command: "unifi-api.sh GET stat/device" }, "c1"),
      result("c1", "state=1", false, "bash"),
      calls("bash", { command: "unifi-api.sh -w POST cmd/devmgr" }, "c2"),
    ])!;
    const at = (needle: string) => t.text.indexOf(needle);
    expect(at("restart the AP")).toBeGreaterThan(-1);
    expect(at("ASSISTANT SAID: I will check")).toBeGreaterThan(at("restart the AP"));
    expect(at("ASSISTANT CALLED bash")).toBeGreaterThan(at("ASSISTANT SAID"));
    expect(at("RESULT OF bash: state=1")).toBeGreaterThan(at("GET stat/device"));
    expect(at("cmd/devmgr")).toBeGreaterThan(at("RESULT OF bash"));
    expect(t.toolCalls).toBe(2);
  });

  it("names the tool of a result from the call when the result does not say", () => {
    const t = renderTurn([user("x"), calls("grep", { pattern: "a" }, "g1"), result("g1", "hit")])!;
    expect(t.text).toContain("RESULT OF grep: hit");
  });

  it("marks errors and an aborted message, and reports how the last message ended", () => {
    const t = renderTurn([
      user("x"),
      calls("bash", { command: "false" }, "c1"),
      result("c1", "exit 1", true, "bash"),
      { role: "assistant", content: [], stopReason: "aborted", timestamp: 1_700_000_004_000 },
    ])!;
    expect(t.text).toContain("RESULT OF bash (ERROR): exit 1");
    expect(t.text).toContain("ASSISTANT MESSAGE ENDED: aborted");
    expect(t.lastStopReason).toBe("aborted");
  });

  it("says so when the turn was stopped before anything was done", () => {
    const t = renderTurn([user("do it")])!;
    expect(t.text).toContain("nothing yet");
    expect(t.toolCalls).toBe(0);
  });

  it("leaves out what roundhouse adds in front of a message", () => {
    const memory = `<roundhouse_memory v="1" date="x">\n${"secret fact ".repeat(500)}\n</roundhouse_memory>\n\nactual question`;
    const t = renderTurn([user(memory)])!;
    expect(t.request).toBe("[memory block left out]\n\nactual question");
    expect(t.text).not.toContain("secret fact");
    expect(stripInjected("<persona>p</persona><tools>t</tools>hello")).toBe("[persona left out][tool notes left out]hello");
  });

  it("keeps the start and the end of long tool output", () => {
    const out = "HEAD" + "x".repeat(5000) + "TAIL";
    const t = renderTurn([user("x"), calls("bash", {}, "c1"), result("c1", out, false, "bash")])!;
    expect(t.text).toContain("HEAD");
    expect(t.text).toContain("TAIL");
    expect(t.text).toContain("characters left out");
    expect(t.text.length).toBeLessThan(3000);
  });

  it("drops the oldest steps, not the newest, when the turn is too long", () => {
    const msgs: unknown[] = [user("big job")];
    for (let i = 0; i < 200; i++) {
      msgs.push(calls("bash", { command: `step-${i} ${"y".repeat(300)}` }, `c${i}`), result(`c${i}`, `out-${i} ${"z".repeat(300)}`, false, "bash"));
    }
    const t = renderTurn(msgs, { maxChars: 20_000 })!;
    expect(t.text.length).toBeLessThanOrEqual(20_000);
    expect(t.stepsOmitted).toBeGreaterThan(0);
    expect(t.text).toContain("big job");
    expect(t.text).toContain("step-199");
    expect(t.text).not.toContain("step-0 ");
    expect(t.text).toMatch(/first \d+ steps of the turn left out/);
    expect(t.toolCalls).toBe(200);
  });

  it("does not throw on shapes it does not know", () => {
    const t = renderTurn([user("x"), null, 5, { role: "custom", customType: "note" }, { role: "assistant", content: "oops" }, { role: "toolResult", content: 7 }])!;
    expect(t.text).toContain("[custom:note message]");
  });
});

describe("clip", () => {
  it("returns short text as it is and cuts long text in the middle", () => {
    expect(clip("short", 10, 5)).toBe("short");
    const c = clip("a".repeat(100) + "b".repeat(100), 10, 10);
    expect(c.startsWith("a".repeat(10))).toBe(true);
    expect(c.endsWith("b".repeat(10))).toBe(true);
    expect(c).toContain("180 characters left out");
  });
});

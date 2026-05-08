/**
 * test/kiro-acp-client.test.ts — Tests for ACP JSON-RPC client
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { AcpClient } from "../src/agents/kiro/acp/client.js";

/** Create a fake child process with piped stdio. */
function createFakeProcess() {
  const stdin = { write: vi.fn() };
  const stdout = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new EventEmitter(),
    pid: 12345,
    kill: vi.fn(),
  });
  return proc as any;
}

describe("AcpClient", () => {
  let proc: ReturnType<typeof createFakeProcess>;
  let client: AcpClient;

  beforeEach(() => {
    proc = createFakeProcess();
    client = new AcpClient(proc, 5000);
  });

  it("sends JSON-RPC request and resolves on response", async () => {
    const promise = client.call("initialize", { version: "1.0" });

    // Verify written payload
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(proc.stdin.write.mock.calls[0][0].replace("\n", ""));
    expect(sent.method).toBe("initialize");
    expect(sent.id).toBe(1);

    // Simulate response
    proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n"));

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it("rejects on error response", async () => {
    const promise = client.call("bad_method", {});

    proc.stdout.emit("data", Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "not found" } }) + "\n"
    ));

    await expect(promise).rejects.toEqual({ code: -1, message: "not found" });
  });

  it("emits notifications", () => {
    const handler = vi.fn();
    client.on("text_chunk", handler);

    proc.stdout.emit("data", Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", method: "text_chunk", params: { text: "hello" } }) + "\n"
    ));

    expect(handler).toHaveBeenCalledWith({ text: "hello" });
  });

  it("handles multiple messages in one chunk", () => {
    const handler = vi.fn();
    client.on("text_chunk", handler);

    const lines = [
      JSON.stringify({ jsonrpc: "2.0", method: "text_chunk", params: { text: "a" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "text_chunk", params: { text: "b" } }),
    ].join("\n") + "\n";

    proc.stdout.emit("data", Buffer.from(lines));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("handles split messages across chunks", async () => {
    const promise = client.call("test", {});

    const full = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) + "\n";
    const mid = Math.floor(full.length / 2);

    proc.stdout.emit("data", Buffer.from(full.slice(0, mid)));
    proc.stdout.emit("data", Buffer.from(full.slice(mid)));

    expect(await promise).toBe("ok");
  });

  it("rejects all pending on process exit", async () => {
    const promise = client.call("slow", {});
    proc.emit("exit", 1);
    await expect(promise).rejects.toThrow("exited with code 1");
  });

  it("notify does not expect a response", () => {
    client.notify("permission/response", { tool_call_id: "abc", decision: "approved" });
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(proc.stdin.write.mock.calls[0][0].replace("\n", ""));
    expect(sent.id).toBeUndefined();
    expect(sent.method).toBe("permission/response");
  });

  it("throws on call after close", async () => {
    client.close();
    await expect(client.call("test", {})).rejects.toThrow("closed");
  });
});

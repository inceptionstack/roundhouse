import { describe, it, expect, afterEach } from "vitest";
import { IpcServer } from "../src/ipc/server";
import { sendIpc } from "../src/ipc/client";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Isolated temp socket — never touches the real ~/.roundhouse/gateway.sock
const TEST_SOCKET = resolve(tmpdir(), `roundhouse-ipc-test-${process.pid}.sock`);

describe("IPC", () => {
  let server: IpcServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    try { unlinkSync(TEST_SOCKET); } catch {}
  });

  it("ping/pong", async () => {
    server = new IpcServer(async (req) => {
      if (req.type === "ping") return { ok: true };
      return { ok: false, error: "unknown" };
    }, TEST_SOCKET);
    await server.start();

    const res = await sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET });
    expect(res).toEqual({ ok: true });
  });

  it("notify returns handler result", async () => {
    server = new IpcServer(async (req) => {
      if (req.type === "notify") return { ok: true };
      return { ok: false, error: "unknown" };
    }, TEST_SOCKET);
    await server.start();

    const res = await sendIpc({ type: "notify", text: "hello" }, { socketPath: TEST_SOCKET });
    expect(res).toEqual({ ok: true });
  });

  it("rejects connection when no server", async () => {
    try { unlinkSync(TEST_SOCKET); } catch {}
    await expect(sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET })).rejects.toThrow("Gateway is not running");
  });

  it("handles handler errors gracefully", async () => {
    server = new IpcServer(async () => {
      throw new Error("handler exploded");
    }, TEST_SOCKET);
    await server.start();

    const res = await sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET });
    expect(res).toEqual({ ok: false, error: "handler exploded" });
  });

  it("handles invalid JSON from client", async () => {
    server = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await server.start();

    // Send raw invalid JSON via low-level socket
    const { createConnection } = await import("node:net");
    const res = await new Promise<string>((resolve) => {
      const conn = createConnection(TEST_SOCKET);
      let data = "";
      conn.on("connect", () => conn.write("not json\n"));
      conn.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { conn.destroy(); resolve(data); } });
    });
    expect(JSON.parse(res.trim())).toEqual({ ok: false, error: "Invalid JSON" });
  });

  it("notify passes session field", async () => {
    let receivedSession: string | undefined;
    server = new IpcServer(async (req) => {
      if (req.type === "notify") receivedSession = req.session;
      return { ok: true };
    }, TEST_SOCKET);
    await server.start();

    await sendIpc({ type: "notify", text: "hi", session: "main" }, { socketPath: TEST_SOCKET });
    expect(receivedSession).toBe("main");
  });

  it("times out on unresponsive server", async () => {
    server = new IpcServer(async () => {
      await new Promise(() => {}); // never resolves
      return { ok: true };
    }, TEST_SOCKET);
    await server.start();

    await expect(
      sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET, timeoutMs: 100 })
    ).rejects.toThrow("IPC timeout");
  });

  it("rejects oversized payload", async () => {
    server = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await server.start();

    // Send >64KB without a newline — server should destroy connection
    const { createConnection } = await import("node:net");
    const res = await new Promise<string>((resolve) => {
      const conn = createConnection(TEST_SOCKET);
      conn.on("connect", () => conn.write("x".repeat(65 * 1024)));
      conn.on("close", () => resolve("closed"));
      conn.on("error", () => resolve("error"));
    });
    expect(["closed", "error"]).toContain(res);
  });

  it("rejects second server on same socket", async () => {
    server = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await server.start();

    const server2 = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await expect(server2.start()).rejects.toThrow("Another gateway is already running");
    // server2 never started, no cleanup needed
  });

  it("stop removes socket file from disk", async () => {
    const { existsSync } = await import("node:fs");
    server = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await server.start();
    expect(existsSync(TEST_SOCKET)).toBe(true);

    server.stop();
    server = null;

    expect(existsSync(TEST_SOCKET)).toBe(false);
  });

  it("start cleans up stale socket from crashed process", async () => {
    // Create a stale socket file (no listener)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(TEST_SOCKET, "");

    server = new IpcServer(async () => ({ ok: true }), TEST_SOCKET);
    await server.start();

    // Should successfully start after removing stale file
    const res = await sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET });
    expect(res).toEqual({ ok: true });
  });

  it("client throws when server drops connection without response", async () => {
    const { createServer: netCreateServer } = await import("node:net");
    const badServer = netCreateServer((conn) => conn.destroy());
    await new Promise<void>((res) => badServer.listen(TEST_SOCKET, res));

    try {
      await expect(
        sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET, timeoutMs: 1000 })
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((res) => badServer.close(() => res()));
      try { unlinkSync(TEST_SOCKET); } catch {}
    }
  });

  it("handles multiple sequential requests independently", async () => {
    let callCount = 0;
    server = new IpcServer(async () => {
      callCount++;
      return { ok: true };
    }, TEST_SOCKET);
    await server.start();

    await sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET });
    await sendIpc({ type: "ping" }, { socketPath: TEST_SOCKET });
    await sendIpc({ type: "notify", text: "hi" }, { socketPath: TEST_SOCKET });

    expect(callCount).toBe(3);
  });
});

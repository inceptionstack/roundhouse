/**
 * ipc/client.ts — CLI client to send messages to the running gateway
 *
 * Connects to ~/.roundhouse/gateway.sock, sends JSON, reads response, closes.
 */

import { createConnection } from "node:net";
import { SOCKET_PATH } from "./server";
import type { IpcRequest, IpcResponse } from "./types";

/**
 * Send a request to the running gateway via IPC.
 * Returns the response, or throws if gateway is unreachable.
 */
export async function sendIpc(request: IpcRequest, opts?: { timeoutMs?: number; socketPath?: string }): Promise<IpcResponse> {
  const { timeoutMs = 5000, socketPath = SOCKET_PATH } = opts ?? {};
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let data = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: IpcResponse | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });

    conn.on("data", (chunk) => {
      data += chunk.toString();
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx === -1) return;
      try {
        finish(JSON.parse(data.slice(0, newlineIdx)));
      } catch {
        finish(new Error("Invalid response from gateway"));
      }
    });

    conn.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        finish(new Error("Gateway is not running. Start with: roundhouse start"));
      } else {
        finish(err);
      }
    });

    conn.on("close", () => finish(new Error("Connection closed without response")));

    timer = setTimeout(() => finish(new Error("IPC timeout")), timeoutMs);
  });
}

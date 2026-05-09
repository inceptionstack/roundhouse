/**
 * ipc/server.ts — Unix socket server for gateway IPC
 *
 * Listens on ~/.roundhouse/gateway.sock.
 * Protocol: newline-delimited JSON (one request, one response, close).
 */

import { createServer, type Server } from "node:net";
import { unlinkSync, chmodSync, existsSync } from "node:fs";
import { ROUNDHOUSE_DIR } from "../config";
import { resolve } from "node:path";
import type { IpcRequest, IpcResponse } from "./types";

export const SOCKET_PATH = resolve(ROUNDHOUSE_DIR, "gateway.sock");

export type IpcHandler = (request: IpcRequest) => Promise<IpcResponse>;

export class IpcServer {
  private server: Server | null = null;
  private socketPath: string;

  constructor(private handler: IpcHandler, socketPath?: string) {
    this.socketPath = socketPath ?? SOCKET_PATH;
  }

  getSocketPath(): string { return this.socketPath; }

  async start(): Promise<void> {
    // Remove stale socket if present (TOCTOU race acknowledged — no fix without flock)
    if (existsSync(this.socketPath)) {
      const { createConnection } = await import("node:net");
      const alive = await new Promise<boolean>((res) => {
        const conn = createConnection(this.socketPath);
        const timer = setTimeout(() => { conn.destroy(); res(false); }, 500);
        conn.on("connect", () => { clearTimeout(timer); conn.end(); res(true); });
        conn.on("error", () => { clearTimeout(timer); res(false); });
      });
      if (alive) {
        throw new Error("Another gateway is already running (socket in use)");
      }
      try { unlinkSync(this.socketPath); } catch {}
    }

    this.server = createServer((conn) => {
      let data = "";
      let handled = false;
      const MAX_BYTES = 64 * 1024; // 64KB

      conn.on("data", (chunk) => {
        if (handled) return;
        data += chunk.toString();
        if (data.length > MAX_BYTES) {
          conn.destroy();
          return;
        }
        const newlineIdx = data.indexOf("\n");
        if (newlineIdx === -1) return;

        handled = true;
        const line = data.slice(0, newlineIdx);

        let request: IpcRequest;
        try {
          request = JSON.parse(line);
        } catch {
          conn.end(JSON.stringify({ ok: false, error: "Invalid JSON" }) + "\n");
          return;
        }

        this.handler(request).then((response) => {
          conn.end(JSON.stringify(response) + "\n");
        }).catch((err) => {
          conn.end(JSON.stringify({ ok: false, error: err.message }) + "\n");
        });
      });

      // Timeout connections that send nothing
      conn.setTimeout(5000, () => conn.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.on("error", onError);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener("error", onError);
        this.server!.on("error", (e) => console.error("[roundhouse] IPC server error:", e.message));
        // Restrict permissions: owner only
        chmodSync(this.socketPath, 0o600);
        console.log(`[roundhouse] IPC listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try { unlinkSync(this.socketPath); } catch {}
  }
}

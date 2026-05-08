/**
 * acp/client.ts — JSON-RPC stdio transport for kiro-cli ACP
 *
 * Handles request/response correlation and notification dispatch.
 * Does NOT manage process lifecycle — that's acp/process.ts.
 */

import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpClient extends EventEmitter {
  private buf = "";
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(private proc: ChildProcessWithoutNullStreams, private requestTimeoutMs = 60_000) {
    super();
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("exit", (code) => {
      this.closed = true;
      this.rejectAll(new Error(`kiro-cli exited with code ${code}`));
      this.emit("exit", code);
    });
  }

  /** Send a JSON-RPC request and await its response. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error("ACP client is closed");

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    this.proc.stdin.write(payload + "\n");

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP call "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
    this.proc.stdin.write(payload + "\n");
  }

  /** Gracefully close — reject pending requests. */
  close(): void {
    this.closed = true;
    this.rejectAll(new Error("ACP client closed"));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ── Private ──────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.emit("parse_error", e, line);
      return;
    }

    // Response to a pending request
    if ("id" in msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)!;
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }

    // Notification from kiro-cli
    if ("method" in msg && typeof msg.method === "string") {
      this.emit(msg.method, msg.params);
      this.emit("notification", msg.method, msg.params);
      return;
    }

    this.emit("unknown_message", msg);
  }

  private rejectAll(error: Error): void {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

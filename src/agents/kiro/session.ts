/**
 * session.ts — Kiro session state management
 *
 * Tracks active sessions per thread, handles idle reaping,
 * and persists session IDs for potential resumption.
 */

import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface SessionEntry {
  sessionId: string;
  threadId: string;
  createdAt: number;
  lastUsed: number;
  inFlight: boolean;
  contextTokens: number | null;
  contextWindow: number | null;
  model: string | null;
}

export interface SessionStoreOptions {
  sessionsDir: string;
  maxIdleMs?: number;
}

/**
 * Manages kiro session entries per thread.
 * Persistence is a simple JSON file per thread for session resumption.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly maxIdleMs: number;
  private readonly sessionsDir: string;

  constructor(opts: SessionStoreOptions) {
    this.sessionsDir = opts.sessionsDir;
    this.maxIdleMs = opts.maxIdleMs ?? 30 * 60 * 1000; // 30 min
  }

  get(threadId: string): SessionEntry | undefined {
    return this.sessions.get(threadId);
  }

  set(threadId: string, entry: SessionEntry): void {
    this.sessions.set(threadId, entry);
    this.persistSession(threadId, entry);
  }

  delete(threadId: string): void {
    this.sessions.delete(threadId);
  }

  get size(): number {
    return this.sessions.size;
  }

  markInFlight(threadId: string, inFlight: boolean): void {
    const entry = this.sessions.get(threadId);
    if (entry) {
      entry.inFlight = inFlight;
      if (!inFlight) entry.lastUsed = Date.now();
    }
  }

  updateContext(threadId: string, tokens: number | null, window: number | null, model?: string): void {
    const entry = this.sessions.get(threadId);
    if (entry) {
      entry.contextTokens = tokens;
      entry.contextWindow = window;
      if (model) entry.model = model;
    }
  }

  /** Return thread IDs of sessions that are idle and not in-flight. */
  getIdleSessions(): string[] {
    const now = Date.now();
    const idle: string[] = [];
    for (const [threadId, entry] of this.sessions) {
      if (!entry.inFlight && (now - entry.lastUsed) > this.maxIdleMs) {
        idle.push(threadId);
      }
    }
    return idle;
  }

  /** Load persisted session ID for a thread (for session/load attempts). */
  loadPersistedSessionId(threadId: string): string | null {
    const filePath = this.sessionFilePath(threadId);
    if (!existsSync(filePath)) return null;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      return data.sessionId ?? null;
    } catch {
      return null;
    }
  }

  // ── Private ──────────────────────────────────────────

  private persistSession(threadId: string, entry: SessionEntry): void {
    const dir = this.threadDir(threadId);
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "kiro.json");
    const tmpPath = filePath + "." + randomBytes(4).toString("hex") + ".tmp";
    writeFileSync(tmpPath, JSON.stringify({
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      lastUsed: entry.lastUsed,
    }) + "\n");
    renameSync(tmpPath, filePath);
  }

  private sessionFilePath(threadId: string): string {
    return resolve(this.threadDir(threadId), "kiro.json");
  }

  private threadDir(threadId: string): string {
    // Sanitize thread ID for filesystem use
    const dirName = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.sessionsDir, dirName);
  }
}

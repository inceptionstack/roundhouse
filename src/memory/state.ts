/**
 * memory/state.ts — Per-thread memory state persistence
 *
 * State lives in ~/.roundhouse/memory-state/<thread-dir>.json
 * Outside the agent workspace so the agent can't accidentally corrupt it.
 */

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUNDHOUSE_DIR } from "../config";
import { threadIdToDir, threadIdToDirLegacy } from "../util";
import type { ThreadMemoryState } from "./types";

const STATE_DIR = resolve(ROUNDHOUSE_DIR, "memory-state");

function stateFilePath(threadId: string): string {
  return resolve(STATE_DIR, `${threadIdToDir(threadId)}.json`);
}

function legacyStateFilePath(threadId: string): string {
  return resolve(STATE_DIR, `${threadIdToDirLegacy(threadId)}.json`);
}

/** Load per-thread memory state (returns empty state if none exists) */
export async function loadThreadMemoryState(threadId: string): Promise<ThreadMemoryState> {
  try {
    const raw = await readFile(stateFilePath(threadId), "utf8");
    return JSON.parse(raw) as ThreadMemoryState;
  } catch {
    // Fallback to legacy encoding for pre-v0.4 state files
    try {
      const legacyPath = legacyStateFilePath(threadId);
      if (legacyPath !== stateFilePath(threadId)) {
        const raw = await readFile(legacyPath, "utf8");
        return JSON.parse(raw) as ThreadMemoryState;
      }
    } catch {}
    return {};
  }
}

/** Save per-thread memory state (atomic write to prevent corruption) */
export async function saveThreadMemoryState(threadId: string, state: ThreadMemoryState): Promise<void> {
  const path = stateFilePath(threadId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

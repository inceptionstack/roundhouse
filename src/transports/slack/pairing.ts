/**
 * transports/slack/pairing.ts — Persistent pending-pairing state for Slack.
 *
 * Used by:
 * - `roundhouse setup --slack`: writes pending pairing before starting
 *   the gateway.
 * - gateway: detects pending pairing and completes on the first
 *   message.im event from an allowed user (or assistant_thread_started
 *   when the workspace has Assistants API enabled — Slack fires that
 *   immediately when the user opens an assistant DM thread, before the
 *   user types anything).
 *
 * The first-DM-from-allowed-user model has a chicken-and-egg gap: Slack
 * `message.im` events only fire for *existing* DM channels. If the user
 * hasn't opened a DM with the bot first, we never see a message — hence
 * the assistant_thread_started fallback in §2.4 of slack-plan.md.
 */

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUNDHOUSE_DIR } from "../../config";

export interface PendingSlackPairing {
  version: 1;
  /** Slack workspace team ID (Txxx). Captured at first event. */
  workspaceTeamId?: string;
  /** Slack bot user id (Uxxx). Captured at gateway start via auth.test. */
  botUserId?: string;
  /** Lowercase usernames that may complete the pairing. */
  allowedUsers: string[];
  /** Optionally allow Slack user IDs (`Uxxx`) directly — for assistant_thread_started where userName isn't known yet. */
  allowedUserIds?: string[];
  createdAt: string;
  status: "pending" | "paired";
  pairedAt?: string;
  /** DM channel ID (Dxxx) once paired. */
  channelId?: string;
  /** Slack user ID (Uxxx) once paired. */
  userId?: string;
  /** Slack username once resolved. */
  username?: string;
}

export const SLACK_PAIRING_PATH = resolve(ROUNDHOUSE_DIR, "slack-pairing.json");

/** Read the pending Slack pairing file. Returns null if missing or invalid. */
export async function readPendingSlackPairing(): Promise<PendingSlackPairing | null> {
  try {
    const raw = await readFile(SLACK_PAIRING_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data?.version === 1 && Array.isArray(data?.allowedUsers) && data?.status) {
      return data as PendingSlackPairing;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic 0600 write. */
export async function writePendingSlackPairing(state: PendingSlackPairing): Promise<void> {
  await mkdir(dirname(SLACK_PAIRING_PATH), { recursive: true });
  const tmp = `${SLACK_PAIRING_PATH}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, SLACK_PAIRING_PATH);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export async function completePendingSlackPairing(result: {
  channelId: string;
  userId: string;
  username?: string;
}): Promise<PendingSlackPairing | null> {
  const existing = await readPendingSlackPairing();
  if (!existing || existing.status !== "pending") return null;
  const completed: PendingSlackPairing = {
    ...existing,
    status: "paired",
    pairedAt: new Date().toISOString(),
    channelId: result.channelId,
    userId: result.userId,
    username: result.username ?? existing.username,
  };
  await writePendingSlackPairing(completed);
  return completed;
}

export async function clearPendingSlackPairing(): Promise<void> {
  try { await unlink(SLACK_PAIRING_PATH); } catch {}
}

/**
 * Check whether `messageOrEvent` matches the pending Slack pairing.
 *
 * Returns the matched pairing details if so, null otherwise. Uses both:
 *  - `author.userName` (lowercased, leading-@ stripped) compared to
 *    `pending.allowedUsers`.
 *  - `author.userId` (raw) compared to `pending.allowedUserIds` — covers
 *    the `assistant_thread_started` path where userName isn't populated
 *    yet (the gateway pre-resolves it via getUser before calling here,
 *    but we still accept Uxxx-literal allowlist entries as a fallback).
 */
export function matchPendingPairing(
  pending: PendingSlackPairing,
  authorUserName: string | undefined,
  authorUserId: string | undefined,
): boolean {
  if (pending.status !== "pending") return false;
  const normalizedName = (authorUserName ?? "").trim().replace(/^@/, "").toLowerCase();
  const allowed = pending.allowedUsers.map((u) => u.replace(/^@/, "").toLowerCase());
  if (normalizedName && allowed.includes(normalizedName)) return true;
  if (authorUserId && pending.allowedUserIds?.includes(authorUserId)) return true;
  return false;
}

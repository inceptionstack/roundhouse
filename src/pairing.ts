/**
 * pairing.ts — Persistent pending-pairing state for Telegram.
 *
 * Used by:
 * - setup --telegram --headless: writes pending pairing before starting gateway
 * - gateway.ts: detects pending pairing and completes on /start <nonce>
 */
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUNDHOUSE_DIR } from "./config";

export interface PendingPairing {
  version: 1;
  nonce: string;
  botUsername: string;
  allowedUsers: string[];
  createdAt: string;
  status: "pending" | "paired";
  pairedAt?: string;
  chatId?: number;
  userId?: number;
  username?: string;
}

export const PAIRING_PATH = resolve(ROUNDHOUSE_DIR, "telegram-pairing.json");

/**
 * Generate a pairing nonce: "rh-" + 8 random hex bytes.
 */
export function createPairingNonce(): string {
  return `rh-${randomBytes(8).toString("hex")}`;
}

/**
 * Build the Telegram deep link for pairing.
 */
export function createPairingLink(botUsername: string, nonce: string): string {
  return `https://t.me/${botUsername}?start=${nonce}`;
}

/**
 * Check if a message text matches /start <nonce>.
 */
export function isStartForNonce(text: string, nonce: string): boolean {
  const trimmed = text.trim();
  return trimmed === `/start ${nonce}` || trimmed === nonce;
}

/**
 * Read the pending pairing file. Returns null if not found or invalid.
 */
export async function readPendingPairing(): Promise<PendingPairing | null> {
  try {
    const raw = await readFile(PAIRING_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data?.version === 1 && data?.nonce && data?.status) {
      return data as PendingPairing;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write pending pairing state (atomic, mode 0600).
 */
export async function writePendingPairing(state: PendingPairing): Promise<void> {
  await mkdir(dirname(PAIRING_PATH), { recursive: true });
  const tmp = `${PAIRING_PATH}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, PAIRING_PATH);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Mark pairing as complete — merges result into existing pending state.
 */
export async function completePendingPairing(result: {
  chatId: number;
  userId: number;
  username: string;
}): Promise<PendingPairing | null> {
  const existing = await readPendingPairing();
  if (!existing || existing.status !== "pending") return null;

  const completed: PendingPairing = {
    ...existing,
    status: "paired",
    pairedAt: new Date().toISOString(),
    chatId: result.chatId,
    userId: result.userId,
    username: result.username,
  };

  await writePendingPairing(completed);
  return completed;
}

/**
 * Clear the pairing file.
 */
export async function clearPendingPairing(): Promise<void> {
  try {
    await unlink(PAIRING_PATH);
  } catch {}
}

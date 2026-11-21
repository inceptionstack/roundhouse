/**
 * util.ts — Pure utility functions for roundhouse
 */

import { randomBytes } from "node:crypto";

/**
 * Debug flag for per-event stream logging. Enabled via
 * ROUNDHOUSE_DEBUG_STREAM=1 in the roundhouse env file. Evaluated once at
 * module load so the hot path (subscription callbacks, event loops) is a
 * single boolean check rather than an env read on every event.
 */
export const DEBUG_STREAM = process.env.ROUNDHOUSE_DEBUG_STREAM === "1";

/**
 * Split a long message into chunks that fit within maxLen.
 * Prefers splitting at newline boundaries.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error(`splitMessage: maxLen must be > 0, got ${maxLen}`);
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    // If we split at a newline, consume it so next chunk doesn't start with \n
    if (splitAt < remaining.length && remaining[splitAt] === "\n") {
      remaining = remaining.slice(splitAt + 1);
    } else {
      remaining = remaining.slice(splitAt);
    }
  }
  return chunks;
}

/**
 * Compare two ids (chat or user) loosely. Treats `12345` and `"12345"` as
 * equal so a heterogeneous allowlist (telegram numeric + slack string) can
 * still detect duplicates without coercion.
 */
export function sameId(a: string | number, b: string | number): boolean {
  return String(a) === String(b);
}

/** Message shape the allowlist reads. `raw` is the platform's own payload. */
export interface AuthorizableMessage {
  author?: { userName?: string; userId?: string | number; fullName?: string };
  raw?: unknown;
  /** Chat SDK thread id, e.g. "telegram:12345" or "slack:C0123:1711.0001". */
  threadId?: string;
}

export interface AllowlistOptions {
  /**
   * Explicit opt-in to an open bot (`chat.allowAll: true`). Without it, an
   * empty allowlist denies everyone.
   */
  allowAll?: boolean;
}

/**
 * The author's platform handle, taken from a field the author cannot choose
 * freely. Only Telegram has one we can read; everything else returns
 * `undefined`, so it can be authorized by id only.
 *
 * The Chat SDK's `author.userName` is not such a field:
 *  - Telegram: the adapter builds it as `from.username ?? from.first_name ??
 *    from.id`, and from the chat title for channel or anonymous-admin posts.
 *    An account with no @username can set its first name to anything. Only
 *    `raw.from.username` is the real, unique @username.
 *  - Slack: it is the display name, which any workspace member can change,
 *    and for bot or webhook posts whatever the poster chose.
 *
 * The platform comes from the thread id prefix when the message has one, and
 * otherwise from the payload's shape. A payload we cannot identify has no
 * verified handle.
 */
export function verifiedHandle(message: AuthorizableMessage): string | undefined {
  const platform = typeof message.threadId === "string" && message.threadId.includes(":")
    ? message.threadId.slice(0, message.threadId.indexOf(":"))
    : undefined;
  if (platform !== undefined && platform !== "telegram") return undefined;

  const raw = message.raw as { from?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const from = raw.from as { id?: unknown; username?: unknown } | null | undefined;
  if (!from || typeof from !== "object" || typeof from.id !== "number") return undefined;
  return typeof from.username === "string" && from.username ? from.username : undefined;
}

/**
 * Check if a Chat SDK message author may use the gateway.
 *
 *  1. `allowedUserIds` non-empty: only those immutable platform ids pass.
 *     Usernames are ignored from then on; a handle can be renamed, released
 *     and re-registered by someone else. Pairing fills this list.
 *  2. Otherwise `allowedUsers` non-empty (not paired yet, or a legacy config):
 *     the verified handle must match, case-insensitively, or the platform id
 *     must be listed there. Never the display name, and never the SDK's
 *     `userName` (see `verifiedHandle`). Only Telegram has a verified handle,
 *     so on Slack a username never grants access: pair to record the id.
 *  3. Both empty: denied, unless `allowAll` was set explicitly.
 *
 * Telegram ids are numeric and Slack ids are strings ("U02XXXXX"); both sides
 * are compared as strings so a mixed list works.
 */
export function isAllowed(
  message: AuthorizableMessage,
  allowedUsers: string[],
  allowedUserIds?: (string | number)[],
  options: AllowlistOptions = {},
): boolean {
  const author = message.author ?? {};

  if (allowedUserIds && allowedUserIds.length > 0) {
    if (author.userId == null || author.userId === "") return false;
    const rawId = String(author.userId);
    return allowedUserIds.some((entry) => String(entry) === rawId);
  }

  if (allowedUsers.length > 0) {
    const wanted = allowedUsers.map((u) => u.replace(/^@/, "").toLowerCase());
    // Older configs list platform ids in allowedUsers. An id is immutable, and
    // a Telegram @username cannot be all digits, so this stays safe.
    if (author.userId != null && author.userId !== "" && wanted.includes(String(author.userId).toLowerCase())) {
      return true;
    }
    const handle = verifiedHandle(message)?.replace(/^@/, "").toLowerCase();
    return !!handle && wanted.includes(handle);
  }

  return options.allowAll === true;
}

/**
 * Start a periodic typing indicator loop.
 * Calls thread.startTyping() immediately and then every intervalMs.
 * Returns a stop function.
 *
 * On stop, also calls thread.stopTyping() if the thread exposes one.
 * Telegram's `sendChatAction` auto-expires after ~5 s so its
 * createThread doesn't bother. Slack's `assistant.threads.setStatus`
 * persists until explicitly cleared OR a message lands in the same
 * `thread_ts` — and our streaming posts to the channel root, not the
 * incoming thread, so the status sticks indefinitely without an
 * explicit clear.
 */
export function startTypingLoop(
  thread: { startTyping: (status?: string) => Promise<void>; stopTyping?: () => Promise<void> | void },
  intervalMs: number = 4000
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Tracks the most recent in-flight startTyping() promise. The cleanup
   * path AWAITS this before sending its clear ("") so a tick that started
   * just before stop() can't land *after* the clear and silently re-set
   * the indicator. The Slack assistant_thread status doesn't auto-expire,
   * so this race translates directly into a stuck "Typing…" pill.
   */
  let inFlight: Promise<void> | undefined;

  const send = () => {
    if (stopped) return;
    inFlight = thread.startTyping().catch(() => {});
  };

  send(); // fire immediately
  timer = setInterval(send, intervalMs);
  if (timer.unref) timer.unref(); // don't hold Node alive

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    // Best-effort cleanup — never throw, never block the caller. We
    // dispatch asynchronously so the caller's `try/finally` returns
    // immediately; the actual clear lands on the next tick after any
    // in-flight startTyping() has resolved.
    void (async () => {
      try { if (inFlight) await inFlight; } catch {}
      // Prefer a transport-supplied stopTyping (Slack injects one that
      // bypasses the SDK's setStatus-with-bad-loading_messages bug).
      // Fall back to the standard thread.startTyping("") for transports
      // (Telegram) that auto-expire or accept the empty arg cleanly.
      const cleared = await tryStopTypingHook(thread);
      if (!cleared) {
        try { await thread.startTyping(""); } catch {}
      }
    })();
  };
}

/**
 * Try the transport-supplied `stopTyping` hook. Returns true if the hook
 * was called (regardless of whether it threw — best-effort), false if the
 * thread doesn't expose one.
 */
async function tryStopTypingHook(
  thread: { stopTyping?: () => Promise<void> | void },
): Promise<boolean> {
  if (typeof thread.stopTyping !== "function") return false;
  try { await thread.stopTyping(); } catch {}
  return true;
}

/**
 * Convert a threadId to a safe directory name.
 * Uses a scheme that avoids collisions between different separators.
 */
export function threadIdToDir(threadId: string): string {
  // Injective filesystem-safe encoding:
  // "_" → "__", ":" → "_c", other special → "_xNN" (hex code)
  return threadId
    .replace(/_/g, "__")    // escape existing underscores first
    .replace(/:/g, "_c")    // encode colons (common in thread IDs)
    .replace(/[^a-zA-Z0-9_-]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Generate a short random attachment ID (e.g. "att_a1b2c3d4").
 */
export function generateAttachmentId(): string {
  return `att_${randomBytes(4).toString("hex")}`;
}

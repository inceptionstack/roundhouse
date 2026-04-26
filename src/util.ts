/**
 * util.ts — Pure utility functions for roundhouse
 */

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
 * Check if a Chat SDK message author is in the allowlist.
 * Only matches on userName (unique handle) and userId (numeric ID).
 * Does NOT match on fullName (user-controlled display name).
 */
export function isAllowed(
  message: { author?: { userName?: string; userId?: string; fullName?: string } },
  allowedUsers: string[]
): boolean {
  if (allowedUsers.length === 0) return true;
  const author = message.author ?? {};
  const candidates = [author.userName, author.userId]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return candidates.some((c) => allowedUsers.includes(c));
}

/**
 * Start a periodic typing indicator loop.
 * Calls thread.startTyping() immediately and then every intervalMs.
 * Returns a stop function.
 */
export function startTypingLoop(
  thread: { startTyping: (status?: string) => Promise<void> },
  intervalMs: number = 4000
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const send = () => {
    if (stopped) return;
    thread.startTyping().catch(() => {});
  };

  send(); // fire immediately
  timer = setInterval(send, intervalMs);
  if (timer.unref) timer.unref(); // don't hold Node alive

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * Convert a threadId to a safe directory name.
 * Uses a scheme that avoids collisions between different separators.
 */
export function threadIdToDir(threadId: string): string {
  // Escape underscores first, then encode special chars:
  // ":" → "_c", "_" → "_u", everything else → "_x"
  return threadId
    .replace(/_/g, "_u")    // escape existing underscores first
    .replace(/:/g, "_c")    // encode colons
    .replace(/[^a-zA-Z0-9_-]/g, "_x"); // encode everything else
}

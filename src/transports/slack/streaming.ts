/**
 * transports/slack/streaming.ts — Post-then-edit streaming for Slack.
 *
 * The Chat SDK's `stream()` API requires `recipientUserId` and
 * `recipientTeamId` in options and is gated on the workspace having
 * Slack's AI Assistant feature enabled. Until we can detect that,
 * we ship this fallback: send an initial message, then edit it in
 * place every ~800 ms with the accumulated text.
 *
 * v3 plan polish:
 *  - throttle BEFORE overflow edits (back-to-back overflows can't burst Slack rate limits)
 *  - check `signal?.aborted` at chunk boundaries
 *  - retry initial post with backoff and a hard cap, then attempt one
 *    final post during flush (so the user never sees silence)
 */

import type { SlackAdapter } from "@chat-adapter/slack";
import type { ChatThread } from "../types";

const STREAM_EDIT_INTERVAL_MS = 800;
const SLACK_TEXT_LIMIT = 12_000;
const SLACK_MIN_PUBLIC_LIMIT = 4_000;
const INIT_FAIL_BACKOFF_MS = 1_500;
const MAX_INIT_RETRIES = 3;

interface SlackThreadShape {
  id?: string;
}

export async function handleSlackStream(
  sdk: SlackAdapter,
  thread: ChatThread,
  stream: AsyncIterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  const threadId = (thread as unknown as SlackThreadShape).id ?? "";
  if (!threadId.startsWith("slack:")) {
    console.warn("[slack/stream] called with non-slack thread id:", threadId);
    return;
  }
  const { channel, threadTs } = sdk.decodeThreadId(threadId);
  const replyOpts = (threadTs && threadTs !== "" && threadTs !== "main")
    ? { thread_ts: threadTs }
    : {};

  let accumulated = "";
  let messageTs: string | null = null;
  let lastEditAt = 0;
  let lastSentText = "";
  let committedLength = 0;
  let initFailures = 0;
  let lastInitAttemptAt = 0;

  const sleepRemaining = async () => {
    const wait = STREAM_EDIT_INTERVAL_MS - (Date.now() - lastEditAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  const sendInitial = async (body: string) => {
    if (initFailures >= MAX_INIT_RETRIES) return;
    // Only enforce backoff when we're actually retrying after a failure;
    // otherwise re-inits after handleOverflow get blocked when a healthy
    // first message happened to land within the backoff window.
    if (initFailures > 0 && Date.now() - lastInitAttemptAt < INIT_FAIL_BACKOFF_MS) return;
    lastInitAttemptAt = Date.now();
    try {
      const result = await sdk.webClient.chat.postMessage({
        channel,
        markdown_text: body,
        ...replyOpts,
      }) as { ts?: string };
      if (!result.ts) {
        // Treat missing ts as a soft failure so subsequent chunks retry once
        // the backoff window passes.
        initFailures++;
        return;
      }
      messageTs = result.ts;
      lastSentText = body;
      lastEditAt = Date.now();
      initFailures = 0;
    } catch (err) {
      initFailures++;
      console.warn(
        `[slack/stream] initial post failed (${initFailures}/${MAX_INIT_RETRIES}):`,
        (err as Error).message,
      );
    }
  };

  const editMessage = async (body: string) => {
    if (!messageTs || body === lastSentText) return;
    try {
      await sdk.webClient.chat.update({
        channel,
        ts: messageTs,
        markdown_text: body,
      });
      lastSentText = body;
      lastEditAt = Date.now();
    } catch {
      // Slack rejects empty/invalid edits silently — keep streaming.
    }
  };

  const handleOverflow = async () => {
    const current = accumulated.slice(committedLength);
    if (current.length <= SLACK_TEXT_LIMIT) return;

    // Throttle before the overflow edit so a burst of large chunks can't
    // fire two edits within the rate-limit window.
    await sleepRemaining();

    // Finalize the current message at a clean boundary (newline if possible).
    const newlineIdx = current.lastIndexOf("\n", SLACK_TEXT_LIMIT - 100);
    const cutAt = newlineIdx > SLACK_MIN_PUBLIC_LIMIT
      ? newlineIdx
      : Math.max(SLACK_MIN_PUBLIC_LIMIT, SLACK_TEXT_LIMIT - 100);
    const final = current.slice(0, cutAt);
    await editMessage(final);
    committedLength += cutAt;
    messageTs = null;
    lastSentText = "";
  };

  /**
   * If the uncommitted buffer is over the limit, slice off a clean
   * sub-12k prefix and post it directly via chat.postMessage (no edit
   * cycle). Returns true if the chunk loop should `continue` because
   * we already drained part of the buffer without an active message.
   */
  const sendOverflowChunkDirect = async (): Promise<boolean> => {
    const current = accumulated.slice(committedLength);
    if (current.length <= SLACK_TEXT_LIMIT) return false;
    const newlineIdx = current.lastIndexOf("\n", SLACK_TEXT_LIMIT - 100);
    const cutAt = newlineIdx > SLACK_MIN_PUBLIC_LIMIT
      ? newlineIdx
      : Math.max(SLACK_MIN_PUBLIC_LIMIT, SLACK_TEXT_LIMIT - 100);
    const slice = current.slice(0, cutAt);
    try {
      await sdk.webClient.chat.postMessage({
        channel,
        markdown_text: slice,
        ...replyOpts,
      });
      committedLength += cutAt;
      // Force a fresh init for whatever's left.
      messageTs = null;
      lastSentText = "";
      return true;
    } catch (err) {
      console.warn("[slack/stream] overflow direct post failed:", (err as Error).message);
      return false;
    }
  };

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    accumulated += chunk;

    if (!messageTs) {
      // If a single chunk pushed us past Slack's per-message cap before
      // we even sent the initial message, slice and post the prefix
      // directly. The remainder will trigger a fresh sendInitial below.
      if (await sendOverflowChunkDirect()) {
        // Re-evaluate with the now-trimmed accumulated buffer.
        const body = accumulated.slice(committedLength);
        if (body.trim()) await sendInitial(body);
        continue;
      }
      const body = accumulated.slice(committedLength);
      if (body.trim()) await sendInitial(body);
      continue;
    }

    await handleOverflow();
    if (signal?.aborted) break;
    if (Date.now() - lastEditAt >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(accumulated.slice(committedLength));
    }
  }

  // Final flush — runs even on abort so the user sees the partial buffer
  // rather than silent truncation.
  const remaining = accumulated.slice(committedLength);
  if (!remaining.trim()) return;

  if (messageTs) {
    await editMessage(remaining);
  } else if (initFailures < MAX_INIT_RETRIES) {
    // We never got an initial message id during the stream — try one more
    // unconditional post so the user isn't left with nothing.
    try {
      await sdk.webClient.chat.postMessage({
        channel,
        markdown_text: remaining,
        ...replyOpts,
      });
    } catch (err) {
      console.error("[slack/stream] final post failed:", (err as Error).message);
    }
  }
}

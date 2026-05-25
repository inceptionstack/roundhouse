/**
 * transports/slack/progress.ts — Editable progress messages for Slack.
 *
 * Mirrors src/transports/telegram/progress.ts: post once, then edit in
 * place via chat.update. The `update()` callback never throws — long-
 * running commands rely on best-effort progress display, not delivery
 * guarantees.
 */

import type { SlackAdapter } from "@chat-adapter/slack";
import type { ChatThread, ProgressMessage } from "../types";

interface SlackThreadShape {
  id?: string;
  adapter?: { slack?: SlackAdapter };
}

/** No-op fallback so we always return a usable ProgressMessage. */
const NOOP_PROGRESS: ProgressMessage = { update: async () => {} };

export async function createSlackProgress(
  sdk: SlackAdapter,
  thread: ChatThread,
  initialText: string,
): Promise<ProgressMessage> {
  const shape = thread as unknown as SlackThreadShape;
  const threadId = typeof shape.id === "string" ? shape.id : null;
  if (!threadId || !threadId.startsWith("slack:")) {
    return NOOP_PROGRESS;
  }

  const { channel, threadTs } = sdk.decodeThreadId(threadId);
  // Slack's encodeThreadId requires a non-empty threadTs; we use "" as
  // a sentinel for top-level posts. A real threadTs (e.g. "1712023032.1234")
  // means we're inside a Slack reply thread.
  const replyOpts = (threadTs && threadTs !== "" && threadTs !== "main")
    ? { thread_ts: threadTs }
    : {};

  let initial: { ts?: string; channel?: string } | undefined;
  try {
    initial = await sdk.webClient.chat.postMessage({
      channel,
      markdown_text: initialText,
      ...replyOpts,
    }) as any;
  } catch (err) {
    console.warn("[slack/progress] initial post failed:", (err as Error).message);
    return NOOP_PROGRESS;
  }

  const ts = initial?.ts;
  if (!ts) return NOOP_PROGRESS;

  return {
    update: async (text: string) => {
      try {
        await sdk.webClient.chat.update({
          channel,
          ts,
          markdown_text: text,
        });
      } catch {
        // ProgressMessage.update is documented to never throw.
      }
    },
  };
}

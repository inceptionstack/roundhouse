/**
 * transports/slack/notify.ts — Slack chat.postMessage helpers.
 *
 * Used outside the gateway (e.g. cron, IPC notify) where we don't have
 * the @chat-adapter/slack instance to hand. Token is read from env.
 *
 * Defaults match the SDK adapter so notify-emitted messages render
 * consistently with messages that flow through `thread.post`.
 */

import { isSlackChatId } from "./format";

const DEFAULT_TIMEOUT = 15_000;

/** Send `markdown_text` to a Slack channel via chat.postMessage. */
export async function postSlackMessage(
  token: string,
  channelId: string,
  text: string,
  options?: { unfurlLinks?: boolean; mrkdwn?: boolean; timeoutMs?: number },
): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: channelId,
        markdown_text: text,
        // Match the SDK's defaults so links don't unfurl unexpectedly in
        // notify-emitted messages while gateway-emitted ones don't.
        unfurl_links: options?.unfurlLinks ?? false,
        mrkdwn: options?.mrkdwn ?? true,
      }),
      signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[slack] postMessage to ${channelId} failed (${res.status}): ${errBody.slice(0, 200)}`);
      return false;
    }
    // Slack returns ok:false in JSON for app-level errors even on HTTP 200.
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (json && json.ok === false) {
      console.warn(`[slack] postMessage to ${channelId} api error: ${json.error ?? "unknown"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[slack] postMessage to ${channelId} failed:`, (err as Error).message);
    return false;
  }
}

/** Filter chatIds to slack-shaped strings and post to each. */
export async function postSlackToMany(
  chatIds: (string | number)[],
  text: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn("[slack] SLACK_BOT_TOKEN not set — skipping notification");
    return;
  }
  const slackIds = chatIds.filter(isSlackChatId) as string[];
  for (const id of slackIds) {
    await postSlackMessage(token, id, text);
  }
}

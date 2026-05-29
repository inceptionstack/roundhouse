/**
 * transports/slack/format.ts — Slack-specific formatting helpers.
 *
 * Outgoing plain messages use `{ markdown }` and the SDK renders to
 * Slack's native `markdown_text`. Outgoing menus use `{ card }` and the
 * SDK runs cardToBlockKit. We don't ship a markdown→mrkdwn converter
 * because both paths flow through the SDK.
 *
 * Helpers exported here are limited to Slack-specific length limits and
 * channel-id shape checks.
 */

/**
 * Slack `markdown_text` field upper bound. The Slack adapter doesn't yet
 * advertise this on its public surface, but it's documented in Slack's
 * Block Kit reference. We split before sending so the adapter doesn't
 * have to chunk for us — mirrors how the Telegram adapter uses
 * `splitMessage` from src/util.ts.
 */
export const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;

/**
 * Pure shape check matching what Slack actually returns from auth.test
 * and webhook events. Stays consistent with `SlackAdapter.ownsChatId`.
 */
export function isSlackChatId(id: string | number): boolean {
  return typeof id === "string" && /^[CDGU]/.test(id);
}

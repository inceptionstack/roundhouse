/**
 * gateway/topic-command.ts — Named topic sessions in private chats
 *
 * Allows switching between independent conversations via /topic <name>.
 * Each topic has its own agent session (memory, context, thread).
 *
 * Usage:
 *   /topic deploy    — switch to "deploy" topic (creates if new)
 *   /topic           — show current topic + list of known topics as
 *                     clickable inline-keyboard buttons (Telegram)
 *   /topic main      — return to default session
 *
 * Inline keyboard: when called with no args in a private chat and at
 * least one known topic exists, we send a Telegram inline keyboard so
 * the user can switch with a tap. Clicking a button fires a callback
 * routed through chat.onAction(TOPIC_ACTION_ID) → handleTopicAction().
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUNDHOUSE_DIR } from "../config";
import {
  encodeCallbackData,
  toKeyboardRows,
  extractTelegramChatId,
  type ChatThreadLike,
  type InlineButton,
  type InlineKeyboard,
} from "./inline-keyboard";

/** Action ID for topic-select inline-keyboard callbacks */
export const TOPIC_ACTION_ID = "topic_select";

/** Special sentinel value used by the "🏠 main (default)" button. */
const MAIN_SENTINEL = "__main__";

const TOPICS_FILE = join(ROUNDHOUSE_DIR, "active-topics.json");

/** Active topic per chat (chatId → topicName). "main" means default. */
let activeTopics = new Map<string, string>();

// Load persisted topics on module init
try {
  const data = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
  activeTopics = new Map(Object.entries(data));
} catch { /* first run or corrupt — start fresh */ }

function persistTopics(): void {
  try {
    mkdirSync(ROUNDHOUSE_DIR, { recursive: true });
    const tmp = TOPICS_FILE + "." + randomBytes(4).toString("hex");
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(activeTopics)));
    renameSync(tmp, TOPICS_FILE);
  } catch (e) { console.error("[roundhouse] failed to persist topics:", e); }
}

/** Get the active topic for a chat. Returns undefined if on default "main". */
export function getActiveTopic(chatId: string): string | undefined {
  const topic = activeTopics.get(chatId);
  return (topic && topic !== "main") ? topic : undefined;
}

/** Apply topic override to a resolved agent thread ID. Scoped per chat. */
export function applyTopicOverride(agentThreadId: string, thread: { id?: string }): string {
  if (agentThreadId !== "main") return agentThreadId;
  const chatId = thread.id?.split(":")[1] ?? thread.id ?? "";
  const topic = getActiveTopic(String(chatId));
  return topic ? `topic:${chatId}:${topic}` : agentThreadId;
}

/** Set the active topic for a chat. */
export function setActiveTopic(chatId: string, topic: string): void {
  if (topic === "main" || topic === "off" || topic === "") {
    activeTopics.delete(chatId);
  } else {
    activeTopics.set(chatId, topic);
  }
  persistTopics();
}

/** Get all known topics for a specific chat from memory-state directory. */
export function listTopics(chatId: string): string[] {
  const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
  // Files are named topic_c<chatId>_c<topicName>.json (threadIdToDir encoding)
  const prefix = `topic_c${chatId}_c`;
  try {
    return readdirSync(stateDir)
      .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
      .map(f => f.slice(prefix.length).replace(/\.json$/, ""))
      .map(f => f.replace(/__/g, "_")); // reverse threadIdToDir underscore encoding
  } catch {
    return [];
  }
}

export interface TopicCommandContext {
  thread: ChatThreadLike;
  text: string;
  postWithFallback: (thread: ChatThreadLike, text: string) => Promise<void>;
}

/** Build an inline keyboard listing all known topics + a "main" escape hatch. */
function buildTopicKeyboard(topics: string[], current: string | undefined): InlineKeyboard {
  const onMain = !current;
  const buttons: InlineButton[] = [];

  // Always include "main (default)" first so users can escape back.
  // ✓ appears when we're currently on main (i.e. no active topic).
  buttons.push({
    text: onMain ? "🏠 main (default) ✓" : "🏠 main (default)",
    callback_data: encodeCallbackData(TOPIC_ACTION_ID, MAIN_SENTINEL),
  });

  for (const t of topics) {
    const isActive = t === current;
    buttons.push({
      text: isActive ? `📂 ${t} ✓` : `📂 ${t}`,
      callback_data: encodeCallbackData(TOPIC_ACTION_ID, t),
    });
  }

  return toKeyboardRows(buttons);
}

/** Normalize a topic name the same way as the command parser. */
function normalizeTopicName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
}

export async function handleTopic(ctx: TopicCommandContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;

  // Extract chat ID from thread (for private: "telegram:<chatId>")
  const chatId = (thread?.id?.split(":")[1] ?? thread?.id ?? "") as string;

  // /topic only works in private chats (groups use forum topics instead)
  if (chatId && chatId.startsWith("-")) {
    await postWithFallback(thread, "⚠️ /topic only works in private chats. Use Telegram forum topics for groups.");
    return;
  }

  // Parse the topic name from the command
  const match = text.match(/^\/topic(?:@\S+)?\s+(.+)/i);
  const topicName = match?.[1] ? normalizeTopicName(match[1]) : "";

  if (!topicName) {
    await showTopicMenu(thread, chatId, postWithFallback);
    return;
  }

  await applyTopicSelection(chatId, topicName, thread, postWithFallback);
}

/** Show the current topic + inline keyboard (or text fallback). */
async function showTopicMenu(
  thread: ChatThreadLike,
  chatId: string,
  postWithFallback: (thread: ChatThreadLike, text: string) => Promise<void>,
): Promise<void> {
  const current = getActiveTopic(chatId);
  const currentDisplay = current ?? "main (default)";
  const known = listTopics(chatId);

  // Try inline keyboard if we have any known topics and the adapter supports
  // raw Telegram calls. Otherwise fall back to text.
  const telegramFetch = thread?.adapter?.telegramFetch;
  if (known.length > 0 && telegramFetch) {
    const tgChatId = extractTelegramChatId(thread);
    if (tgChatId) {
      try {
        await telegramFetch("sendMessage", {
          chat_id: tgChatId,
          text: `📂 Current topic: <b>${currentDisplay}</b>\n\nTap a topic to switch:`,
          parse_mode: "HTML",
          reply_markup: buildTopicKeyboard(known, current),
        });
        return;
      } catch (err) {
        console.warn("[roundhouse] /topic inline keyboard failed, falling back:", (err as Error).message);
      }
    }
  }

  // Text fallback
  let msg = `📂 Current topic: \`${currentDisplay}\`\n\n`;
  if (known.length > 0) {
    msg += `Known topics: ${known.map(t => `\`${t}\``).join(", ")}\n\n`;
  }
  msg += `Switch with: \`/topic <name>\`\nReturn to default: \`/topic main\``;
  await postWithFallback(thread, msg);
}

/**
 * Apply a topic selection. Shared by `/topic <name>` and inline-keyboard clicks.
 * `topicName` must already be normalized (or be a known sentinel like "main").
 */
export async function applyTopicSelection(
  chatId: string,
  topicName: string,
  thread: ChatThreadLike,
  postWithFallback: (thread: ChatThreadLike, text: string) => Promise<void>,
): Promise<void> {
  setActiveTopic(chatId, topicName);
  const isDefault = topicName === "main" || topicName === "off" || topicName === "";
  const display = isDefault ? "main (default)" : topicName;
  const emoji = isDefault ? "🏠" : "📂";
  const suffix = isDefault
    ? "Back to the default session."
    : "Agent context is now independent for this topic.";
  await postWithFallback(thread, `${emoji} Switched to topic: \`${display}\`\n\n${suffix}`);
}

/**
 * Handle inline-keyboard callback for topic selection.
 * Call this from chat.onAction(TOPIC_ACTION_ID, ...).
 */
export async function handleTopicAction(event: {
  value?: string;
  thread: ChatThreadLike;
}): Promise<void> {
  const raw = event.value;
  if (!raw) return;

  const thread = event.thread;
  const chatId = (thread?.id?.split(":")[1] ?? thread?.id ?? "") as string;
  if (!chatId) return;

  const topicName = raw === MAIN_SENTINEL ? "main" : normalizeTopicName(raw);
  if (!topicName && raw !== MAIN_SENTINEL) return;

  const postFn = async (_t: ChatThreadLike, text: string) => {
    if (!thread?.post) return;
    try { await thread.post({ markdown: text }); }
    catch { try { await thread.post(text); } catch { /* ignore */ } }
  };

  await applyTopicSelection(chatId, topicName, thread, postFn);
}

/**
 * gateway/topic-command.ts \u2014 Named topic sessions in private chats
 *
 * Allows switching between independent conversations via /topic <name>.
 * Each topic has its own agent session (memory, context, thread).
 *
 * Usage:
 *   /topic deploy    \u2014 switch to "deploy" topic (creates if new)
 *   /topic           \u2014 show current topic + list of known topics as
 *                     a clickable menu
 *   /topic main      \u2014 return to default session
 *
 * Routing rule (CRITICAL): this module returns *agent-session* ids like
 * "topic:<chatId>:<name>" via applyTopicOverride() and setActiveTopic(),
 * but it never modifies the *transport* thread object. The chat thread
 * passed into the gateway dispatcher \u2014 and from there into handleTopic /
 * handleTopicAction \u2014 keeps its original `.adapter` and `.id`. Agent
 * thread id flows as a separate string parameter; that separation is what
 * keeps the menu surface working from inside a named-topic session.
 *
 * Transport-free: this module returns RichResponse data; the gateway
 * hands it to the active TransportAdapter for rendering.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUNDHOUSE_DIR } from "../config";
import type { RichResponse } from "../transports";
import { buildSelectableMenu } from "../transports";

/** Action ID for topic-select inline-keyboard callbacks */
export const TOPIC_ACTION_ID = "topic_select";

/**
 * Special sentinel value used by the "main (default)" button.
 *
 * Must be a string `normalizeTopicName()` can never emit, so a user who
 * creates a topic via `/topic <name>` can't accidentally collide with it.
 * The normalizer strips leading/trailing `-`, so any sentinel starting or
 * ending with `-` is unrepresentable as a user-created topic name.
 *
 * Exported for invariant property tests.
 */
export const MAIN_SENTINEL = "-main";

const TOPICS_FILE = join(ROUNDHOUSE_DIR, "active-topics.json");

/** Active topic per chat (chatId \u2192 topicName). "main" means default. */
let activeTopics = new Map<string, string>();

// Load persisted topics on module init
try {
  const data = JSON.parse(readFileSync(TOPICS_FILE, "utf8"));
  activeTopics = new Map(Object.entries(data));
} catch { /* first run or corrupt \u2014 start fresh */ }

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

/**
 * Apply topic override to a resolved *agent* thread ID. Scoped per chat.
 *
 * NOTE: this only rewrites the agent-session id string. The transport
 * thread object is never modified \u2014 see the module doc above.
 */
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

/**
 * Minimal thread shape this module reads. Narrower than `MinimalThread`
 * from transports/types: `id` may be absent for synthetic callers that
 * haven't constructed one yet (e.g. boot turns), and we don't depend on
 * `post`. Read-only — we never mutate or write to the thread here.
 */
export interface TopicThread {
  id?: string;
}

export interface TopicCommandContext {
  thread: TopicThread;
  text: string;
}

/** Normalize a topic name the same way as the command parser. */
export function normalizeTopicName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
}

/** Extract the chat id from a thread's id string (for both private and group threads). */
function chatIdFromThread(thread: TopicThread): string {
  return (thread?.id?.split(":")[1] ?? thread?.id ?? "") as string;
}

/**
 * Build the topic-selection menu as a transport-neutral RichResponse.
 * Delegates to the shared `buildSelectableMenu` picker helper, with the
 * "main (default)" sentinel button prepended.
 */
function buildTopicMenu(chatId: string): RichResponse {
  const current = getActiveTopic(chatId);
  const known = listTopics(chatId);
  const currentDisplay = current ?? "main (default)";

  return buildSelectableMenu({
    current,
    options: known.map((t) => ({ key: t, label: `\ud83d\udcc2 ${t}` })),
    actionId: TOPIC_ACTION_ID,
    textHeader: `\ud83d\udcc2 *Current topic:* \`${currentDisplay}\``,
    textHint: "Switch with: `/topic <name>`\nReturn to default: `/topic main`",
    columns: 2,
    sentinel: {
      label: "\ud83c\udfe0 main (default)",
      value: MAIN_SENTINEL,
      activeWhenCurrentIsUndefined: true,
    },
  });
}

export function handleTopic(ctx: TopicCommandContext): RichResponse {
  const { thread, text } = ctx;
  const chatId = chatIdFromThread(thread);

  // /topic only works in private chats (groups use forum topics instead).
  if (chatId && chatId.startsWith("-")) {
    return { text: "\u26a0\ufe0f /topic only works in private chats. Use Telegram forum topics for groups." };
  }

  // Parse the topic name from the command.
  const match = text.match(/^\/topic(?:@\S+)?\s+(.+)/i);
  const topicName = match?.[1] ? normalizeTopicName(match[1]) : "";

  if (!topicName) {
    return buildTopicMenu(chatId);
  }

  return applyTopicSelection(chatId, topicName);
}

/**
 * Apply a topic selection. Shared by `/topic <name>` and menu clicks.
 * `topicName` must already be normalized (or be a known sentinel like "main").
 */
export function applyTopicSelection(chatId: string, topicName: string): RichResponse {
  setActiveTopic(chatId, topicName);
  const isDefault = topicName === "main" || topicName === "off" || topicName === "";
  const display = isDefault ? "main (default)" : topicName;
  const emoji = isDefault ? "\ud83c\udfe0" : "\ud83d\udcc2";
  const suffix = isDefault
    ? "Back to the default session."
    : "Agent context is now independent for this topic.";
  return { text: `${emoji} Switched to topic: \`${display}\`\n\n${suffix}` };
}

/**
 * Handle inline-keyboard callback for topic selection.
 * Wired from the descriptor's `actions[TOPIC_ACTION_ID]`.
 */
export function handleTopicAction(event: { value?: string; thread: TopicThread }): RichResponse | void {
  const raw = event.value;
  if (!raw) return;

  const chatId = chatIdFromThread(event.thread);
  if (!chatId) return;

  const topicName = raw === MAIN_SENTINEL ? "main" : normalizeTopicName(raw);
  if (!topicName && raw !== MAIN_SENTINEL) return;

  return applyTopicSelection(chatId, topicName);
}

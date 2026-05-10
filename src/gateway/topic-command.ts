/**
 * gateway/topic-command.ts — Named topic sessions in private chats
 *
 * Allows switching between independent conversations via /topic <name>.
 * Each topic has its own agent session (memory, context, thread).
 *
 * Usage:
 *   /topic deploy    — switch to "deploy" topic (creates if new)
 *   /topic           — show current topic + list all
 *   /topic main      — return to default session
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUNDHOUSE_DIR } from "../config";

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
    writeFileSync(TOPICS_FILE, JSON.stringify(Object.fromEntries(activeTopics)));
  } catch (e) { console.error("[roundhouse] failed to persist topics:", e); }
}

/** Get the active topic for a chat. Returns undefined if on default "main". */
export function getActiveTopic(chatId: string): string | undefined {
  const topic = activeTopics.get(chatId);
  return (topic && topic !== "main") ? topic : undefined;
}

/** Apply topic override to a resolved agent thread ID. */
export function applyTopicOverride(agentThreadId: string, thread: { id?: string }): string {
  if (agentThreadId !== "main") return agentThreadId;
  const chatId = thread.id?.split(":")[1] ?? thread.id ?? "";
  const topic = getActiveTopic(String(chatId));
  return topic ? `topic:${topic}` : agentThreadId;
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

/** Get all known topics from memory-state directory. */
export function listTopics(): string[] {
  const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
  try {
    return readdirSync(stateDir)
      .filter(f => f.startsWith("topic_c") && f.endsWith(".json"))
      .map(f => f.replace(/^topic_c/, "").replace(/\.json$/, ""))
      .map(f => f.replace(/__/g, "_")); // reverse threadIdToDir encoding
  } catch {
    return [];
  }
}

export interface TopicCommandContext {
  thread: { id: string };
  text: string;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

export async function handleTopic(ctx: TopicCommandContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;

  // Extract chat ID from thread (for private: "telegram:<chatId>")
  const chatId = thread.id?.split(":")[1] ?? thread.id;

  // Parse the topic name from the command
  const match = text.match(/^\/topic(?:@\S+)?\s+(.+)/i);
  const topicName = match?.[1]?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");

  if (!topicName) {
    // Show current topic + known topics
    const current = getActiveTopic(chatId) ?? "main (default)";
    const known = listTopics();
    let msg = `📂 Current topic: \`${current}\`\n\n`;
    if (known.length > 0) {
      msg += `Known topics: ${known.map(t => `\`${t}\``).join(", ")}\n\n`;
    }
    msg += `Switch with: \`/topic <name>\`\nReturn to default: \`/topic main\``;
    await postWithFallback(thread, msg);
    return;
  }

  setActiveTopic(chatId, topicName);
  const display = topicName === "main" || topicName === "off" ? "main (default)" : topicName;
  const isNew = topicName !== "main" && topicName !== "off";
  const emoji = isNew ? "📂" : "🏠";
  await postWithFallback(thread, `${emoji} Switched to topic: \`${display}\`\n\nAgent context is now independent for this topic.`);
}

/**
 * gateway/model-command.ts — Handle the /model command
 *
 * Allows switching the default AI model from Telegram.
 * Reads/writes ~/.pi/agent/settings.json (defaultProvider + defaultModel).
 *
 * When called without arguments, shows an inline keyboard with model buttons.
 * When a button is clicked, the onAction handler applies the selection.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

/** Known model aliases → Bedrock model IDs */
export const MODEL_ALIASES: Record<string, { provider: string; model: string; label: string }> = {
  "opus": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-6", label: "Claude Opus 4.6" },
  "opus-4.7": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-7", label: "Claude Opus 4.7" },
  "sonnet": { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  "haiku": { provider: "amazon-bedrock", model: "us.anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5" },
};

/** Models shown in the inline keyboard (short aliases only) */
const KEYBOARD_MODELS = ["opus-4.7", "opus", "sonnet", "haiku"] as const;

/** Action ID for model selection callbacks */
export const MODEL_ACTION_ID = "model_select";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Callback data prefix used by @chat-adapter/telegram */
const CALLBACK_PREFIX = "chat:";

export interface ModelCommandContext {
  thread: any;
  text: string;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, any>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getCurrentModel(settings: Record<string, any>): string {
  const provider = settings.defaultProvider ?? "unknown";
  const model = settings.defaultModel ?? "unknown";
  for (const [alias, info] of Object.entries(MODEL_ALIASES)) {
    if (info.provider === provider && info.model === model) return `${info.label}`;
  }
  return `${model}`;
}

function encodeCallbackData(actionId: string, value: string): string {
  return `${CALLBACK_PREFIX}${JSON.stringify({ a: actionId, v: value })}`;
}

function buildInlineKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows = KEYBOARD_MODELS.map(alias => {
    const info = MODEL_ALIASES[alias];
    return [{
      text: info.label,
      callback_data: encodeCallbackData(MODEL_ACTION_ID, alias),
    }];
  });
  return { inline_keyboard: rows };
}

export async function handleModel(ctx: ModelCommandContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;
  const parts = text.split(/\s+/).slice(1);
  const target = parts[0]?.toLowerCase();

  const settings = readSettings();

  // No argument: show inline keyboard
  if (!target) {
    const current = getCurrentModel(settings);
    const msgText = `🤖 Current model: <b>${current}</b>\n\nSelect a model:`;

    // Try to send with inline keyboard via telegramFetch
    const adapter = thread?.adapter;
    if (adapter?.telegramFetch) {
      const chatId = thread?.platformThreadId?.split(":")?.[0] ?? thread?.id?.split(":")?.[0];
      if (chatId) {
        try {
          await adapter.telegramFetch("sendMessage", {
            chat_id: chatId,
            text: msgText,
            parse_mode: "HTML",
            reply_markup: buildInlineKeyboard(),
          });
          return;
        } catch (err) {
          console.warn("[roundhouse] /model inline keyboard failed, falling back:", (err as Error).message);
        }
      }
    }

    // Fallback: plain text
    const aliases = KEYBOARD_MODELS.map(a => `  \`${a}\` → ${MODEL_ALIASES[a].label}`).join("\n");
    await postWithFallback(thread, `🤖 *Current model:* ${current}\n\n*Available:*\n${aliases}\n\n_Usage:_ \`/model sonnet\``);
    return;
  }

  // Resolve alias
  await applyModelSelection(target, settings, thread, postWithFallback);
}

/**
 * Apply a model selection (used by both /model <arg> and inline keyboard callback).
 */
export async function applyModelSelection(
  target: string,
  settings: Record<string, any> | null,
  thread: any,
  postWithFallback: (thread: any, text: string) => Promise<void>,
): Promise<void> {
  if (!settings) settings = readSettings();

  const resolved = MODEL_ALIASES[target];
  if (!resolved) {
    if (target.includes(".") || target.includes("/")) {
      const provider = settings.defaultProvider ?? "amazon-bedrock";
      settings.defaultModel = target;
      settings.defaultProvider = provider;
      writeSettings(settings);
      await postWithFallback(thread, `✅ Model set to: \`${provider}/${target}\``);
    } else {
      const aliases = Object.keys(MODEL_ALIASES).join(", ");
      await postWithFallback(thread, `❌ Unknown model: \`${target}\`\n\nAvailable: ${aliases}`);
    }
    return;
  }

  settings.defaultProvider = resolved.provider;
  settings.defaultModel = resolved.model;
  writeSettings(settings);

  await postWithFallback(thread, `✅ Switched to *${resolved.label}*`);
  console.log(`[roundhouse] /model: switched to ${resolved.provider}/${resolved.model}`);
}

/**
 * Handle inline keyboard callback for model selection.
 * Call this from chat.onAction(MODEL_ACTION_ID, ...).
 */
export async function handleModelAction(event: {
  value?: string;
  thread: any;
}): Promise<void> {
  const alias = event.value;
  if (!alias) return;

  const settings = readSettings();
  const resolved = MODEL_ALIASES[alias];
  if (!resolved) return;

  settings.defaultProvider = resolved.provider;
  settings.defaultModel = resolved.model;
  writeSettings(settings);

  // Post confirmation to the thread
  if (event.thread) {
    try {
      await event.thread.post({ markdown: `✅ Switched to *${resolved.label}*` });
    } catch {
      try { await event.thread.post(`✅ Switched to ${resolved.label}`); } catch {}
    }
  }
  console.log(`[roundhouse] /model (button): switched to ${resolved.provider}/${resolved.model}`);
}

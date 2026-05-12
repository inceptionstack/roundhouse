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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  encodeCallbackData,
  toKeyboardRows,
  extractTelegramChatId,
  type InlineButton,
  type InlineKeyboard,
} from "./inline-keyboard";

/** Known model aliases → Bedrock model IDs */
export const MODEL_ALIASES: Record<string, { provider: string; model: string; label: string }> = {
  // Anthropic Claude
  "opus-4.7": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-7", label: "Claude Opus 4.7" },
  "opus": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-6", label: "Claude Opus 4.6" },
  "sonnet": { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  "haiku": { provider: "amazon-bedrock", model: "us.anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5" },
  // DeepSeek
  "deepseek": { provider: "amazon-bedrock", model: "us.deepseek.r1-v1:0", label: "DeepSeek R1" },
  // Meta Llama
  "llama": { provider: "amazon-bedrock", model: "us.meta.llama4-maverick-17b-instruct-v1:0", label: "Llama 4 Maverick" },
  // Amazon Nova
  "nova-pro": { provider: "amazon-bedrock", model: "us.amazon.nova-pro-v1:0", label: "Amazon Nova Pro" },
  // Mistral
  "mistral": { provider: "amazon-bedrock", model: "us.mistral.mistral-large-2411-v1:0", label: "Mistral Large" },
};

/** Models shown in the inline keyboard (max 8, ordered by preference) */
const KEYBOARD_MODELS = [
  "opus-4.7", "opus", "sonnet", "haiku",
  "deepseek", "llama", "nova-pro", "mistral",
] as const;

/** Action ID for model selection callbacks */
export const MODEL_ACTION_ID = "model_select";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

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
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
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

function buildInlineKeyboard(): InlineKeyboard {
  // Layout: 2 buttons per row for compact display
  const buttons: InlineButton[] = KEYBOARD_MODELS.map(alias => {
    const info = MODEL_ALIASES[alias];
    return {
      text: info.label,
      callback_data: encodeCallbackData(MODEL_ACTION_ID, alias),
    };
  });
  return toKeyboardRows(buttons);
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
      const chatId = extractTelegramChatId(thread);
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
  if (!alias || !MODEL_ALIASES[alias]) return;

  const postFn = async (_t: any, text: string) => {
    if (!event.thread) return;
    try { await event.thread.post({ markdown: text }); }
    catch { try { await event.thread.post(text); } catch {} }
  };

  await applyModelSelection(alias, null, event.thread, postFn);
}

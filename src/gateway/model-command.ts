/**
 * gateway/model-command.ts — Handle the /model command
 *
 * Allows switching the default AI model from Telegram.
 * Reads/writes ~/.pi/agent/settings.json (defaultProvider + defaultModel).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

/** Known model aliases → Bedrock model IDs */
const MODEL_ALIASES: Record<string, { provider: string; model: string; label: string }> = {
  "opus": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-6", label: "Claude Opus 4.6" },
  "opus-4.6": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-6", label: "Claude Opus 4.6" },
  "opus-4.7": { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-4-7", label: "Claude Opus 4.7" },
  "sonnet": { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  "sonnet-4.6": { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  "haiku": { provider: "amazon-bedrock", model: "us.anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5" },
  "haiku-4.5": { provider: "amazon-bedrock", model: "us.anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5" },
};

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
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getCurrentModel(settings: Record<string, any>): string {
  const provider = settings.defaultProvider ?? "unknown";
  const model = settings.defaultModel ?? "unknown";
  // Try to find a friendly label
  for (const [alias, info] of Object.entries(MODEL_ALIASES)) {
    if (info.provider === provider && info.model === model) return `${info.label} (${alias})`;
  }
  return `${provider}/${model}`;
}

export async function handleModel(ctx: ModelCommandContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;
  const parts = text.split(/\s+/).slice(1);
  const target = parts[0]?.toLowerCase();

  const settings = readSettings();

  // No argument: show current model + available options
  if (!target) {
    const current = getCurrentModel(settings);
    const aliases = Object.entries(MODEL_ALIASES)
      .filter(([alias]) => !alias.includes(".")) // Show short aliases only
      .map(([alias, info]) => `  \`${alias}\` → ${info.label}`)
      .join("\n");

    await postWithFallback(thread, `🤖 *Current model:* ${current}\n\n*Available:*\n${aliases}\n\n_Usage:_ \`/model sonnet\``);
    return;
  }

  // Resolve alias or use as raw model ID
  const resolved = MODEL_ALIASES[target];
  if (!resolved) {
    // Check if it looks like a full model ID (contains a dot or slash)
    if (target.includes(".") || target.includes("/")) {
      // Use as-is with current provider
      const provider = settings.defaultProvider ?? "amazon-bedrock";
      settings.defaultModel = target;
      settings.defaultProvider = provider;
      writeSettings(settings);
      await postWithFallback(thread, `✅ Model set to: \`${provider}/${target}\`\n\n⚠️ Restart needed: \`/restart\``);
    } else {
      const aliases = Object.keys(MODEL_ALIASES).filter(a => !a.includes(".")).join(", ");
      await postWithFallback(thread, `❌ Unknown model: \`${target}\`\n\nAvailable: ${aliases}`);
    }
    return;
  }

  settings.defaultProvider = resolved.provider;
  settings.defaultModel = resolved.model;
  writeSettings(settings);

  await postWithFallback(thread, `✅ Model switched to: *${resolved.label}*\n\n⚠️ Takes effect on next agent turn (new sessions use new model).`);
  console.log(`[roundhouse] /model: switched to ${resolved.provider}/${resolved.model}`);
}

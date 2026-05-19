/**
 * gateway/model-command.ts \u2014 Handle the /model command
 *
 * Allows switching the default AI model from chat. Reads/writes
 * ~/.pi/agent/settings.json (defaultProvider + defaultModel).
 *
 * This module is intentionally transport-free. It returns RichResponse
 * data; the gateway hands it to the active TransportAdapter for rendering
 * (Telegram inline keyboard, plain text on text-only transports, etc.).
 *
 * Behaviour:
 *   /model            \u2192 RichResponse with menu (current model + buttons)
 *   /model <alias>    \u2192 RichResponse with confirmation text only
 *   button click      \u2192 RichResponse with confirmation text only
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { RichResponse } from "../transports";
import { buildSelectableMenu } from "../transports";
import { updatePiSettings } from "../pi-settings";

/** Known model aliases \u2192 Bedrock model IDs */
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

/** Models shown in the menu (max 8, ordered by preference) */
const KEYBOARD_MODELS = [
  "opus-4.7", "opus", "sonnet", "haiku",
  "deepseek", "llama", "nova-pro", "mistral",
] as const;

/** Action ID for model selection callbacks */
export const MODEL_ACTION_ID = "model_select";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export interface ModelCommandContext {
  text: string;
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getCurrentModelLabel(settings: Record<string, any>): string {
  const provider = settings.defaultProvider ?? "unknown";
  const model = settings.defaultModel ?? "unknown";
  for (const [, info] of Object.entries(MODEL_ALIASES)) {
    if (info.provider === provider && info.model === model) return info.label;
  }
  return String(model);
}

/**
 * Build the /model menu as a transport-neutral RichResponse.
 * Delegates to the shared `buildSelectableMenu` picker helper.
 */
function buildModelMenu(currentLabel: string): RichResponse {
  // Map our label-based "current" semantics into the helper's key-based
  // semantics by finding the alias whose label matches.
  // TODO: introduce getCurrentModelAlias() upstream so the round-trip
  // (alias → label → alias) goes away. With 8 models the O(n) lookup is
  // negligible; the smell is purely about clarity.
  const currentAlias = KEYBOARD_MODELS.find(
    (alias) => MODEL_ALIASES[alias].label === currentLabel,
  );

  return buildSelectableMenu({
    current: currentAlias,
    options: KEYBOARD_MODELS.map((alias) => ({
      key: alias,
      label: MODEL_ALIASES[alias].label,
    })),
    actionId: MODEL_ACTION_ID,
    textHeader: `\ud83e\udd16 *Current model:* ${currentLabel}`,
    textHint: "_Usage:_ `/model sonnet`",
    columns: 2,
  });
}

export async function handleModel(ctx: ModelCommandContext): Promise<RichResponse> {
  const parts = ctx.text.split(/\s+/).slice(1);
  const target = parts[0]?.toLowerCase();

  const settings = readSettings();

  // No argument: show menu (current model + clickable list).
  if (!target) {
    return buildModelMenu(getCurrentModelLabel(settings));
  }

  return applyModelSelection(target);
}

/**
 * Apply a model selection (used by both `/model <arg>` and the menu callback).
 * Returns a RichResponse with confirmation text.
 */
export async function applyModelSelection(
  target: string,
): Promise<RichResponse> {
  const resolved = MODEL_ALIASES[target];
  if (!resolved) {
    if (target.includes(".") || target.includes("/")) {
      // Treat as a raw provider/model id passthrough.
      const settings = readSettings();
      const provider = settings.defaultProvider ?? "amazon-bedrock";
      await updatePiSettings((s) => ({
        ...s,
        defaultProvider: provider,
        defaultModel: target,
      }));
      return { text: `\u2705 Model set to: \`${provider}/${target}\`` };
    }
    const aliases = Object.keys(MODEL_ALIASES).join(", ");
    return { text: `\u274c Unknown model: \`${target}\`\n\nAvailable: ${aliases}` };
  }

  await updatePiSettings((s) => ({
    ...s,
    defaultProvider: resolved.provider,
    defaultModel: resolved.model,
  }));

  console.log(`[roundhouse] /model: switched to ${resolved.provider}/${resolved.model}`);
  return { text: `\u2705 Switched to *${resolved.label}*` };
}

/**
 * Handle inline-keyboard callback for model selection.
 * Wired from the descriptor's `actions[MODEL_ACTION_ID]`.
 */
export async function handleModelAction(event: { value?: string }): Promise<RichResponse | void> {
  const alias = event.value;
  if (!alias || !MODEL_ALIASES[alias]) return;
  return applyModelSelection(alias);
}

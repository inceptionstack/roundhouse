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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { RichResponse } from "../transports";
import { buildSelectableMenu } from "../transports";

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

type ModelChoice = { provider: string; model: string; label: string };

/** pi's thinking-level suffix on an enabledModels entry, e.g. "…sonnet-4-5:high". */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;
/** Telegram allows 64 bytes of callback data, which also carries the action id. */
const MAX_CALLBACK_VALUE_BYTES = 32;

/**
 * The models to offer: what pi itself is set up with on this host.
 *
 * pi's `enabledModels` setting lists the models the owner enabled as
 * `provider/model-id`, optionally with a `:thinking-level` suffix. When it has
 * usable entries they replace the built-in aliases above, which name specific
 * Bedrock model ids and go stale; picking a retired one would break pi for the
 * gateway and for the pi CLI, since both read the same settings.json.
 * Glob patterns and entries without a provider are skipped.
 *
 * Alias: the model id without a vendor path ("us.anthropic.claude-opus-5-5"
 * -> "opus-5-5") but with dotted versions kept ("gpt-5.1" stays "gpt-5.1").
 * Two entries that would share an alias get "provider/alias".
 */
export function modelChoices(settings: Record<string, any>): { aliases: Record<string, ModelChoice>; order: string[] } {
  const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const aliases: Record<string, ModelChoice> = Object.create(null);
  const order: string[] = [];
  for (const entry of enabled) {
    if (typeof entry !== "string" || /[*?[\]{}!]/.test(entry)) continue;
    const slash = entry.indexOf("/");
    if (slash <= 0 || slash === entry.length - 1) continue;
    const provider = entry.slice(0, slash);
    const model = entry.slice(slash + 1).replace(THINKING_SUFFIX, "");
    if (!model) continue;
    // A dot separates a vendor path only when what follows is a name, not the
    // minor part of a version number.
    const lastDot = model.lastIndexOf(".");
    const tail = lastDot >= 0 && /^[A-Za-z]/.test(model.slice(lastDot + 1)) ? model.slice(lastDot + 1) : model;
    let alias = tail.replace(/^claude-/, "").toLowerCase();
    if (!alias) continue;
    if (alias in aliases) {
      if (aliases[alias].provider === provider && aliases[alias].model === model) continue;
      alias = `${provider.toLowerCase()}/${alias}`;
      if (alias in aliases) continue;
    }
    aliases[alias] = { provider, model, label: tail };
    order.push(alias);
  }
  if (order.length > 0) return { aliases, order: order.slice(0, 8) };
  for (const key of Object.keys(MODEL_ALIASES)) aliases[key] = MODEL_ALIASES[key];
  return { aliases, order: [...KEYBOARD_MODELS] };
}

/**
 * The value a menu button carries: the alias, or "#<position>" when the alias
 * would not fit in Telegram's callback data (one oversized button makes
 * Telegram reject the whole keyboard).
 */
export function callbackValue(alias: string, index: number): string {
  return Buffer.byteLength(alias, "utf8") <= MAX_CALLBACK_VALUE_BYTES ? alias : `#${index}`;
}

/** Reverse of `callbackValue`. Returns undefined for anything not on the menu. */
export function aliasFromCallback(value: string, choices: { aliases: Record<string, ModelChoice>; order: string[] }): string | undefined {
  const byIndex = /^#(\d+)$/.exec(value);
  if (byIndex) return choices.order[Number(byIndex[1])];
  return Object.hasOwn(choices.aliases, value) ? value : undefined;
}

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

function writeSettings(settings: Record<string, any>): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getCurrentModelLabel(settings: Record<string, any>): string {
  const provider = settings.defaultProvider ?? "unknown";
  const model = settings.defaultModel ?? "unknown";
  for (const info of Object.values(modelChoices(settings).aliases)) {
    if (info.provider === provider && info.model === model) return info.label;
  }
  return String(model);
}

/**
 * Build the /model menu as a transport-neutral RichResponse.
 * Delegates to the shared `buildSelectableMenu` picker helper.
 */
function buildModelMenu(currentLabel: string, settings: Record<string, any>): RichResponse {
  const { aliases, order } = modelChoices(settings);
  // Map our label-based "current" semantics into the helper's key-based
  // semantics by finding the alias whose label matches.
  // TODO: introduce getCurrentModelAlias() upstream so the round-trip
  // (alias → label → alias) goes away. With 8 models the O(n) lookup is
  // negligible; the smell is purely about clarity.
  const currentAlias = order.find(
    (alias) => aliases[alias].label === currentLabel,
  );

  return buildSelectableMenu({
    current: currentAlias === undefined ? undefined : callbackValue(currentAlias, order.indexOf(currentAlias)),
    options: order.map((alias, index) => ({
      key: callbackValue(alias, index),
      label: aliases[alias].label,
    })),
    actionId: MODEL_ACTION_ID,
    textHeader: `\ud83e\udd16 *Current model:* ${currentLabel}`,
    textHint: `_Usage:_ \`/model ${order[0] ?? "sonnet"}\``,
    columns: 2,
  });
}

export async function handleModel(ctx: ModelCommandContext): Promise<RichResponse> {
  const parts = ctx.text.split(/\s+/).slice(1);
  // Aliases are lower case; a raw "provider/Model-ID" keeps its own case.
  const typed = parts[0];
  const target = typed && (typed.includes("/") || typed.includes(".")) && !Object.hasOwn(modelChoices(readSettings()).aliases, typed.toLowerCase())
    ? typed
    : typed?.toLowerCase();

  const settings = readSettings();

  // No argument: show menu (current model + clickable list).
  if (!target) {
    return buildModelMenu(getCurrentModelLabel(settings), settings);
  }

  return applyModelSelection(target, settings);
}

/**
 * Apply a model selection (used by both `/model <arg>` and the menu callback).
 * Returns a RichResponse with confirmation text.
 */
export function applyModelSelection(
  target: string,
  settings: Record<string, any> | null,
): RichResponse {
  if (!settings) settings = readSettings();

  // Own keys only: "constructor" or "__proto__" must not resolve to something
  // inherited and write an undefined model into pi's settings.
  const { aliases: known } = modelChoices(settings);
  const resolved = Object.hasOwn(known, target) ? known[target] : undefined;
  if (!resolved) {
    if (target.includes(".") || target.includes("/")) {
      // Raw id passthrough: "provider/model-id", or a bare model id on the
      // current provider.
      const slash = target.indexOf("/");
      const provider = slash > 0 ? target.slice(0, slash) : (settings.defaultProvider ?? "amazon-bedrock");
      const model = slash > 0 ? target.slice(slash + 1) : target;
      if (!model) return { text: `\u274c Unknown model: \`${target}\`` };
      settings.defaultModel = model;
      settings.defaultProvider = provider;
      writeSettings(settings);
      return { text: `\u2705 Model set to: \`${provider}/${model}\`` };
    }
    const aliases = Object.keys(known).join(", ");
    return { text: `\u274c Unknown model: \`${target}\`\n\nAvailable: ${aliases}` };
  }

  settings.defaultProvider = resolved.provider;
  settings.defaultModel = resolved.model;
  writeSettings(settings);

  console.log(`[roundhouse] /model: switched to ${resolved.provider}/${resolved.model}`);
  return { text: `\u2705 Switched to *${resolved.label}*` };
}

/**
 * Handle inline-keyboard callback for model selection.
 * Wired from the descriptor's `actions[MODEL_ACTION_ID]`.
 */
export function handleModelAction(event: { value?: string }): RichResponse | void {
  if (!event.value) return;
  const settings = readSettings();
  const alias = aliasFromCallback(event.value, modelChoices(settings));
  if (!alias) return;
  return applyModelSelection(alias, settings);
}

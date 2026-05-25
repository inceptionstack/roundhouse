/**
 * transports/chat-adapters.ts — Chat SDK adapter factory registry
 *
 * Maps a transport name (key in `config.chat.adapters`) to a lazy factory
 * that returns a configured `@chat-adapter/<name>` instance for the
 * Vercel Chat SDK. Lazy because each adapter package is an optional
 * dependency — we don't crash if a non-configured one is uninstalled.
 *
 * Adding a new chat platform = one entry here + a `TransportAdapter`
 * implementation under `src/transports/<name>/`.
 */

/**
 * A factory that builds a chat-SDK adapter instance from its config block.
 * The return type is `unknown` because the chat SDK's `Adapter` interface
 * is generic over the platform's raw event/thread types — different per
 * platform, and we don't unify them here.
 */
type ChatAdapterFactory = (config: Record<string, unknown>) => unknown;

/** Lazy factory: imports the adapter package only when it's needed. */
type LazyChatAdapterFactory = () => Promise<ChatAdapterFactory>;

export const chatAdapterFactories: Record<string, LazyChatAdapterFactory> = {
  telegram: async () => {
    const { createTelegramAdapter } = await import("@chat-adapter/telegram");
    return (cfg) => createTelegramAdapter({
      mode: (cfg.mode as "auto" | "polling" | "webhook" | undefined) ?? "auto",
    });
  },
  slack: async () => {
    const mod = await import("@chat-adapter/slack").catch(() => null);
    if (!mod) {
      throw new Error(
        "Slack transport configured but @chat-adapter/slack is not installed. " +
        "Run: npm install @chat-adapter/slack",
      );
    }
    const { createSlackAdapter } = mod as typeof import("@chat-adapter/slack");
    return (cfg) => createSlackAdapter({
      mode: (cfg.mode as "socket" | "webhook" | undefined) ?? "socket",
      // CRITICAL: createSlackAdapter only env-falls-back env vars when ZERO
      // config is passed (zeroConfig = !config). Because we pass an object,
      // we MUST forward the env vars explicitly — otherwise webClient calls
      // throw `AuthenticationError: No bot token available …`.
      // Verified against @chat-adapter/slack@4.29.0 dist/index.js:4233-4243.
      botToken: (cfg.botToken as string | undefined) ?? process.env.SLACK_BOT_TOKEN,
      appToken: (cfg.appToken as string | undefined) ?? process.env.SLACK_APP_TOKEN,
      signingSecret: (cfg.signingSecret as string | undefined) ?? process.env.SLACK_SIGNING_SECRET,
    });
  },
};

/**
 * Build the `Chat` adapters map from a roundhouse `config.chat.adapters`
 * block. Throws if a configured key has no factory (so a typo at config
 * time fails at startup, not silently).
 */
export async function buildChatAdapters(
  config: Record<string, Record<string, unknown> | undefined>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(config)) {
    if (!cfg) continue;
    const factory = chatAdapterFactories[name];
    if (!factory) {
      throw new Error(
        `Unknown chat adapter "${name}" in config.chat.adapters. ` +
        `Known adapters: ${Object.keys(chatAdapterFactories).join(", ")}`,
      );
    }
    const create = await factory();
    out[name] = create(cfg);
  }
  return out;
}

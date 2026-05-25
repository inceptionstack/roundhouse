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
    // @chat-adapter/slack is added in Phase 2; until then this throws on use.
    // The factory is registered eagerly so Phase 1 tests can verify the
    // registry contract without depending on Phase 2 deliverables.
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
      // Tokens come from env (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET)
      // — the SDK auto-detects them. Don't pass explicitly unless overridden in cfg.
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

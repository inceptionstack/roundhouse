/**
 * Resolve the correct bot username for a given thread, respecting per-adapter overrides.
 * 
 * Pattern: Store optional override in adapter config (e.g., `chat.adapters.slack.botUsername`),
 * then resolve at dispatch time with fallback to global `chat.botUsername`.
 * 
 * Responsibility: single concern — map thread → transport → override ← global fallback.
 */

export interface BotUsernameResolverConfig {
  globalBotUsername: string;
  adapterOverrides: Record<string, string>; // e.g., { slack: "slackbot", telegram: "telegrambot" }
}

export class BotUsernameResolver {
  constructor(private config: BotUsernameResolverConfig) {}

  /**
   * Resolve the bot username for a thread.
   * 
   * Strategy:
   * 1. Infer transport name from thread ID prefix (e.g., "slack:C01:1712" → "slack").
   * 2. Check if adapter has an override (e.g., `adapterOverrides.slack`).
   * 3. Fall back to global username.
   * 
   * Returns empty string if no username is configured (caller must handle).
   */
  resolve(thread: any): string {
    const transportName = this.inferTransportFromThread(thread);
    
    if (transportName && transportName in this.config.adapterOverrides) {
      return this.config.adapterOverrides[transportName];
    }
    
    return this.config.globalBotUsername;
  }

  /** Infer transport name from thread.id prefix (e.g., "slack:...", "telegram:...") */
  private inferTransportFromThread(thread: any): string | null {
    if (!thread?.id || typeof thread.id !== "string") return null;
    
    const prefix = thread.id.split(":")[0];
    return prefix && prefix.match(/^[a-z]+$/) ? prefix : null;
  }
}

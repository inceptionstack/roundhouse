/**
 * transports/types.ts — Transport adapter interface
 *
 * Defines the contract for platform-specific transport adapters.
 * The gateway uses this interface to remain transport-agnostic.
 */

/** Minimal thread interface (subset of Chat SDK thread) */
export interface ChatThread {
  id: string;
  post(text: string): Promise<void>;
  [key: string]: unknown;
}

/** Minimal incoming message interface */
export interface IncomingMessage {
  text?: string;
  author?: { userName?: string; name?: string; userId?: string | number; id?: string };
  chatId?: number;
  raw?: { from?: { id?: number } };
  [key: string]: unknown;
}

/** Result of a successful transport pairing */
export interface PairingResult {
  /** Thread/channel ID for notifications */
  threadId: number;
  /** User ID for allowlist */
  userId: number;
  /** Display name */
  username: string;
}

/**
 * TransportAdapter — platform-specific behavior contract.
 *
 * Encapsulates all concerns specific to a messaging platform
 * (Telegram, Slack, Discord, etc.), keeping the gateway transport-agnostic.
 */
export interface TransportAdapter {
  /** Transport name (e.g. "telegram") */
  readonly name: string;

  /** Enrich prompt text before sending to agent (e.g. formatting hints) */
  enrichPrompt(text: string): string;

  /** Post a message using platform-native formatting */
  postMessage(thread: ChatThread, text: string): Promise<void>;

  /** Register bot commands with the platform */
  registerCommands(token: string): Promise<void>;

  /** Check if a thread belongs to this transport */
  ownsThread(thread: ChatThread): boolean;

  /** Send notifications to configured recipients */
  notify(chatIds: number[], text: string): Promise<void>;

  /**
   * Check if a pairing flow is pending.
   * Gateway uses this to decide whether to attempt pairing on incoming messages.
   */
  isPairingPending(): Promise<boolean>;

  /**
   * Try to handle an incoming message as a pairing attempt.
   * Returns PairingResult on success, null if not a pairing message.
   * Transport manages its own state (nonce files, OAuth tokens, etc.)
   */
  handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null>;
}

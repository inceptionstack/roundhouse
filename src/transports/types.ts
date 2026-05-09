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
  author?: { name?: string; id?: string };
  [key: string]: unknown;
}

/** Progress/typing indicator handle */
export interface ProgressHandle {
  update(text: string): Promise<void>;
  stop(): void;
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
}

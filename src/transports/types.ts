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

/**
 * RichButton — a single clickable button in a rich menu.
 *
 * `actionId` is a gateway-level identifier (matches CommandDescriptor.actions[K]).
 * `value` is the payload sent back to the action handler when clicked.
 * Transports translate this into platform-native callback payloads.
 */
export interface RichButton {
  label: string;
  actionId: string;
  value: string;
  /** Visual hint that this button is the currently-active selection. */
  selected?: boolean;
}

/** A grouped row/region of buttons inside a RichMenu. */
export interface RichMenuSection {
  title?: string;
  /** Layout hint; transports may ignore. Defaults to 2. */
  columns?: 1 | 2 | 3;
  buttons: RichButton[];
}

/**
 * RichMenu — a transport-agnostic menu of buttons.
 *
 * Commands return menus as data; transports render them. Telegram maps
 * sections to inline-keyboard rows; text-only adapters ignore the menu and
 * fall back to RichResponse.text.
 */
export interface RichMenu {
  title?: string;
  body?: string;
  sections: RichMenuSection[];
}

/**
 * RichResponse — what a command returns to the gateway.
 *
 * `text` is mandatory and is the canonical fallback. `menu` is optional;
 * transports that can't render menus simply post the text.
 */
export interface RichResponse {
  text: string;
  menu?: RichMenu;
}

/** Result of a successful transport pairing */
export interface PairingResult {
  /** Thread/channel ID for notifications */
  threadId: string | number;
  /** User ID for allowlist */
  userId: string | number;
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

  /**
   * Post a rich response (text + optional menu).
   *
   * Required on every adapter. Adapters that can't render a menu (text-only
   * transports) MUST fall back to `postMessage(thread, response.text)`.
   * Adapters that CAN render a menu MUST also fall back to text on any
   * transport-level failure (network error, missing platform handle, etc.).
   */
  postRich(thread: ChatThread, response: RichResponse): Promise<void>;

  /** Register bot commands with the platform */
  registerCommands(token: string): Promise<void>;

  /** Check if a thread belongs to this transport */
  ownsThread(thread: ChatThread): boolean;

  /** Send notifications to configured recipients */
  notify(chatIds: number[], text: string): Promise<void>;

  /**
   * Create a thread object for a given chat ID.
   * Used by gateway for synthetic turns (boot turn, cron notifications)
   * where no incoming message triggered the interaction.
   * Returns a thread compatible with the streaming system.
   */
  createThread(chatId: number): ChatThread;

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

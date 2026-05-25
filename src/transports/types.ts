/**
 * transports/types.ts — Transport adapter interface
 *
 * Defines the contract for platform-specific transport adapters.
 * The gateway uses this interface to remain transport-agnostic.
 */

/**
 * Postable shapes accepted by `ChatThread.post`.
 *
 * Mirrors the subset of Chat SDK `AdapterPostableMessage` we actually use:
 * plain string, `{ markdown }`, and `{ card, fallbackText? }`. Card payload
 * is `unknown` to avoid coupling this interface to a specific Chat SDK
 * version's `CardElement` type — adapters narrow at the boundary.
 */
export type ChatThreadPost =
  | string
  | { markdown: string }
  | { card: unknown; fallbackText?: string };

/** Minimal thread interface (subset of Chat SDK thread) */
export interface ChatThread {
  id: string;
  post(message: ChatThreadPost): Promise<void>;
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
 * Minimal thread shape commands can rely on regardless of transport.
 *
 * Sized to what command handlers actually call: id, post, optional
 * startTyping. Adapters return richer objects at the platform boundary
 * (Telegram threads carry adapter.telegramFetch + platformThreadId);
 * commands deliberately don't see those.
 */
export interface MinimalThread {
  id: string;
  post(text: string): Promise<void>;
  startTyping?(): void;
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
  /**
   * Action payload sent back when the button is clicked.
   *
   * Intentionally a flat string (not an object) — keeps callback encoding
   * simple across transports (Telegram callback_data is 64 bytes max).
   * If structured payload is needed, JSON-encode into this field and
   * decode in the action handler. Sentinel values (e.g. "-main") must
   * be unrepresentable by the normalization function of the value space
   * they share — see topic-command.ts MAIN_SENTINEL for the pattern.
   */
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
 *
 * Note: header/body text lives on `RichResponse.text` rather than on the
 * menu itself — the Telegram inline-keyboard renderer doesn't have a
 * separate slot for it. When a transport with a real card layout (Slack
 * Block Kit, Discord embeds) lands, add structured fields back with a
 * matching renderer.
 */
export interface RichMenu {
  sections: RichMenuSection[];
}

/**
 * RichResponse — what a command returns to the gateway.
 *
 * - `text` is mandatory and is the canonical text-only fallback. Used by
 *   transports that can't render menus, or when menu rendering fails.
 * - `menu` is optional; transports that can render menus use it.
 * - `menuCaption` is optional; when present AND the menu is rendered,
 *   transports show this *instead of* `text` as the message body next to
 *   the keyboard. This avoids duplication between the buttons and a
 *   verbose option list. When the menu can't render, transports fall
 *   back to `text` (which can be more verbose).
 *
 * Convention: `text` is for the no-menu world (full info), `menuCaption`
 * is for the with-menu world (concise context). Commands that don't care
 * about the distinction can just set `text`; transports treat that as
 * "use the same body in both cases" by falling back to `text` when
 * `menuCaption` is absent.
 */
export interface RichResponse {
  text: string;
  menu?: RichMenu;
  menuCaption?: string;
}

/**
 * ProgressMessage — handle to a transport-rendered progress message.
 *
 * Returned by `TransportAdapter.progress()`. `update(text)` is allowed
 * to silently no-op on transports that can't edit messages in place
 * (the initial text was already posted).
 */
export interface ProgressMessage {
  update(text: string): Promise<void>;
}

/** Result of a successful transport pairing */
export interface PairingResult {
  /** Thread/channel ID for notifications */
  threadId: string | number;
  /** User ID for allowlist */
  userId: string | number;
  /** Display name */
  username: string;
  /**
   * Transport name that produced this result. The composite transport
   * fills this in when fanning out `handlePairing`. Individual delegates
   * may omit it (the composite assigns its own `.name` after the call).
   */
  transport?: string;
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

  /**
   * Enrich prompt text before sending to agent (e.g. formatting hints).
   *
   * `thread` is provided so the composite transport can route to the
   * delegate that owns the thread. Single-transport adapters may ignore
   * the argument.
   */
  enrichPrompt(thread: ChatThread, text: string): string;

  /** Post a message using platform-native formatting */
  postMessage(thread: ChatThread, text: string): Promise<void>;

  /**
   * Render a rich response (text + optional menu).
   *
   * **Precondition:** Implementations MUST NOT throw. On failure (network,
   * rate limit, missing capability), they must degrade gracefully — log
   * internally and post `response.text` as plain text via best-effort.
   * The gateway dispatcher relies on this guarantee and does not wrap
   * calls to this method in try/catch.
   *
   * Adapters that can't render a menu (text-only transports) MUST fall
   * back to `postMessage(thread, response.text)`. Adapters that CAN render
   * a menu MUST also fall back to text on any transport-level failure
   * (network error, missing platform handle, etc.).
   */
  postRich(thread: ChatThread, response: RichResponse): Promise<void>;

  /**
   * Open an editable progress message used by long-running commands like
   * /update, /compact, /doctor.
   *
   * Adapters that can't natively edit messages MUST still satisfy this
   * contract by posting `initialText` once and treating subsequent
   * `update()` calls as no-ops. Either way the caller never imports a
   * platform-specific module.
   */
  progress(thread: ChatThread, initialText: string): Promise<ProgressMessage>;

  /**
   * Register bot commands with the platform.
   *
   * Adapter is responsible for sourcing its own credentials from env.
   * No-op when prerequisites are missing (so callers can fire
   * unconditionally without checking transport-specific env vars).
   */
  registerCommands(): Promise<void>;

  /** Check if a thread belongs to this transport */
  ownsThread(thread: ChatThread): boolean;

  /**
   * Pure shape check — return true iff this transport recognizes the given
   * chat ID format. No I/O. Used by the composite transport to partition
   * `notifyChatIds` and route notify() calls.
   *
   * Telegram: typeof id === "number" || /^-?\d+$/.test(String(id))
   * Slack:    typeof id === "string" && /^[CDGU]/.test(id)
   */
  ownsChatId(id: string | number): boolean;

  /**
   * Build a synthetic "parent thread id" for sub-agent / cron routing
   * from a single chat id. Encodes the platform prefix and any
   * coordinates the transport needs.
   *
   * Telegram: `telegram:${chatId}:main`
   * Slack:    `slack:${channelId}:main`
   */
  encodeParentThreadId(chatId: string | number): string;

  /**
   * Format a chat id for human-facing "Session: …" labels in startup
   * notifications. Replaces inline platform-specific logic in the gateway.
   */
  formatNotifySession(chatId: string | number): string;

  /** Send notifications to configured recipients */
  notify(chatIds: (string | number)[], text: string): Promise<void>;

  /**
   * Create a thread object for a given chat ID.
   * Used by gateway for synthetic turns (boot turn, cron notifications)
   * where no incoming message triggered the interaction.
   * Returns a thread compatible with the streaming system.
   */
  createThread(chatId: string | number): ChatThread;

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

  /**
   * Optional pre-handler hook: return true to drop the message before any
   * other gateway logic runs. Lets transports filter platform-specific
   * sentinel messages (e.g. Telegram's `/start <nonce>`).
   *
   * Composite routes to the delegate that owns the thread; if no delegate
   * owns it, the message is not dropped.
   */
  shouldIgnoreMessage?(text: string, message: IncomingMessage, thread: ChatThread): boolean;

  /**
   * Stream agent text into a single thread message with progressive edits.
   *
   * Adapters that lack streaming MUST still satisfy this contract by
   * collecting the iterable into chunks and calling `postMessage` for each.
   * `signal` is honored at chunk boundaries — when aborted, the adapter
   * SHOULD finalize the current message rather than truncate silently.
   */
  stream(thread: ChatThread, iter: AsyncIterable<string>, signal?: AbortSignal): Promise<void>;
}

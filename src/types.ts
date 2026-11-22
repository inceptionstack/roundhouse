/**
 * types.ts — Core abstractions for roundhouse
 */

// ── Attachments ──────────────────────────────────────

/** A file attachment received from a chat platform and saved locally */
export interface MessageAttachment {
  /** Stable attachment ID (e.g. "att_a1b2c3d4") */
  id: string;
  /** Attachment type from the chat platform */
  mediaType: "audio" | "image" | "file" | "video";
  /** Sanitized filename */
  name: string;
  /** Absolute local path where the file was saved */
  localPath: string;
  /** MIME type (from platform metadata or fallback) */
  mime: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Whether this is user-provided (untrusted) content */
  untrusted: true;
  /** Set by an adapter that passed this file to the model directly as an image. */
  inline?: boolean;
  /** Transcript of audio content (populated by STT service) */
  transcript?: import("./voice/types").AttachmentTranscript;
}

// ── Agent adapter ────────────────────────────────────

/** A user message with optional attachments */
export interface AgentMessage {
  /** User's text (may be empty for attachment-only messages) */
  text: string;
  /** File attachments saved locally by the gateway */
  attachments?: MessageAttachment[];
}

/** Events yielded by the streaming prompt interface */
export type AgentStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolCallId: string }
  | { type: "tool_end"; toolName: string; toolCallId: string; isError: boolean }
  | { type: "turn_end" }
  | { type: "draining" }
  | { type: "drain_complete" }
  | { type: "agent_end" }
  | { type: "custom_message"; customType: string; content: string }
  | { type: "model_error"; message: string };

// ── AdapterInfo ──────────────────────────────────────

/**
 * Information returned by getInfo(). All fields optional.
 * Consumers (gateway /status, memory lifecycle) read these keys.
 */
export interface AdapterInfo {
  /** Agent SDK/CLI version string */
  version?: string;
  /** Currently active model identifier */
  model?: string;
  /** Working directory the agent operates in */
  cwd?: string;
  /** Number of active sessions managed by this adapter */
  activeSessions?: number;

  // ── Context usage (drives memory pressure detection) ─

  /** Current token count in context */
  contextTokens?: number | null;
  /** Maximum context window size in tokens */
  contextWindow?: number | null;
  /** Percentage of context used (0-100) */
  contextPercent?: number | null;
  /** Thinking level of the thread's session, when the agent has one. */
  thinkingLevel?: string;
  /** What the thread's session has cost so far, in USD, as the agent accounts it. */
  sessionCost?: number;
  /** Tokens the thread's session has used so far. */
  sessionTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };

  // ── Memory system integration ──────────────────────

  /** Whether agent has its own memory extension (determines roundhouse memory mode) */
  hasMemoryExtension?: boolean;
  /** Names of memory-related tools the agent exposes */
  memoryTools?: string[];

  // ── Extensions / capabilities ──────────────────────

  /** List of loaded extension paths/names */
  extensions?: string[];

  /**
   * "system-prompt" when the adapter carries the gateway's standing context
   * (persona, tool notes) in its system prompt. The gateway then does not
   * repeat it in front of every user message.
   */
  standingContext?: "system-prompt";

  /** Additional adapter-specific fields */
  [key: string]: unknown;
}

/**
 * AgentAdapter interface — the contract between gateway and adapters.
 *
 * New adapters should extend BaseAdapter (from ./agents/base-adapter.ts)
 * which provides default implementations for optional methods.
 */
export interface AgentAdapter {
  /** Unique agent name, e.g. "pi", "kiro" */
  readonly name: string;

  // ── Required ─────────────────────────────────────────

  /** Send a user message and return the full assistant response */
  prompt(threadId: string, message: AgentMessage): Promise<AgentResponse>;

  /** Send a user message and stream back events in real time. */
  promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent>;

  /** Tear down all sessions and release resources. */
  dispose(): Promise<void>;

  // ── Optional (have defaults in BaseAdapter) ──────────

  /** Prompt using a specific model (e.g. Haiku for memory flush). */
  promptWithModel?(threadId: string, message: AgentMessage, modelId: string): Promise<AgentResponse>;

  /** Dispose the session for a thread and start fresh on next prompt. */
  restart?(threadId: string): Promise<void>;

  /** Compact the session context for a thread. */
  compact?(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;

  /** Compact with a specific model. */
  compactWithModel?(threadId: string, modelId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;

  /**
   * Soft-reset an overflowed session by trimming on-disk history to the
   * most-recent few turns. Called by memory lifecycle when compact() fails
   * because the session itself is too large for the model's context window.
   *
   * Returns a report describing what was trimmed (shape is adapter-specific
   * but always has `reset: boolean`), or null if not applicable.
   * Adapters without on-disk sessions (in-memory only) should return null.
   */
  softReset?(threadId: string): Promise<{ reset: boolean } | null>;

  /** Abort the current agent run for a thread. */
  abort?(threadId: string): Promise<void>;

  /**
   * What the agent has done in this thread since the last message from the
   * owner, as plain text for a reviewer (`/stop` hands it to one): the request,
   * and every step with the tool results, shortened to a readable size. Safe to
   * call while a turn is running or right after an abort. Null when the thread
   * has no conversation or no turn yet.
   */
  describeTurn?(threadId: string, opts?: { maxChars?: number }): Promise<TurnDescription | null>;

  /**
   * Switch the conversation in this thread to another model ("provider/id").
   * `applied: false` leaves it as it is and says why in `detail`; with
   * `usable: false` the model cannot be used here at all (unknown, or no
   * credentials). `deferred` means a turn is running and the switch happens
   * when it ends.
   */
  setModel?(
    threadId: string,
    model: string,
    /** Called with the outcome of a deferred switch, once it has been tried. */
    onDeferred?: (result: { applied: boolean; detail?: string }) => void,
  ): Promise<{ applied: boolean; deferred?: boolean; usable?: boolean; detail?: string }>;

  /**
   * Read or set the thinking level of the conversation in this thread.
   * Returns the level now in effect and the levels its model supports.
   */
  thinkingLevel?(threadId: string, level?: string): Promise<{ level: string; available: string[]; deferred?: boolean } | null>;

  /** Return runtime info about the agent (model, version, etc.). */
  getInfo?(threadId?: string): AdapterInfo;

  /**
   * Hook called after message is built (attachments resolved, STT transcribed)
   * but before memory injection and prompt/promptStream. Adapter can append
   * platform-specific hints, rewrite text, etc. Return the (possibly modified) message.
   */
  prepareMessage?(threadId: string, message: AgentMessage, context: MessageContext): AgentMessage;
}

/** A turn of a conversation in words, for `AgentAdapter.describeTurn`. */
export interface TurnDescription {
  /** Markdown: the request and the steps. */
  text: string;
  /** The owner's request that began the turn. */
  request: string;
  toolCalls: number;
  /** Oldest steps left out of `text` because the turn was long. */
  stepsOmitted: number;
  /** How the last assistant message ended ("aborted" after a stop), when known. */
  lastStopReason?: string;
  /** The raw transcript on disk, when the agent keeps one. */
  sessionFile?: string;
}

export interface MessageContext {
  /** Chat platform: "telegram", "discord", etc. */
  platform: string;
  /** Whether the message has file/image/audio attachments */
  hasAttachments: boolean;
}

export interface AgentResponse {
  text: string;
  /** Agent-specific metadata (tokens, cost, model, etc.) */
  metadata?: Record<string, unknown>;
}

/** Factory that creates an AgentAdapter from its config block */
export type AgentAdapterFactory = (
  config: Record<string, unknown>
) => AgentAdapter;

// ── Agent router ─────────────────────────────────────

export interface AgentRouter {
  /** Resolve which agent handles a given thread */
  resolve(threadId: string): AgentAdapter;

  /** Dispose all agents owned by the router */
  dispose(): Promise<void>;
}

// ── Gateway config ───────────────────────────────────

export interface GatewayConfig {
  /** Config schema version for future migrations */
  _version?: number;
  agent: {
    type: string;
    [key: string]: unknown;
  };
  chat: {
    botUsername: string;
    /**
     * Handles allowed before pairing has recorded an id. Ignored as soon as
     * `allowedUserIds` has an entry: a handle can change owner, an id cannot.
     */
    allowedUsers?: string[];
    /**
     * Let anyone use the bot when both allowlists are empty. Off by default:
     * an empty allowlist refuses every message.
     */
    allowAll?: boolean;
    /** Answer in private chats only; ignore groups, channels and topics. */
    dmOnly?: boolean;
    /** Run a greeting agent turn on every start (default true). */
    bootTurn?: boolean;
    /**
     * Allow `/update` from chat (default true). It installs the latest
     * published roundhouse and its bundle on the host, then restarts.
     */
    allowUpdateCommand?: boolean;
    /**
     * Immutable per-platform user IDs (paired during setup).
     * Telegram IDs are numeric (e.g. 123456789); Slack IDs are strings
     * (e.g. "U02XXXXX"). The allowlist is a heterogeneous union so a single
     * gateway running both transports can authenticate users from either.
     */
    allowedUserIds?: (string | number)[];
    /**
     * Per-platform chat IDs to notify on startup.
     * Telegram chat IDs are numeric (negative for groups); Slack channel IDs
     * are strings starting with C/D/G. The composite transport partitions
     * this list by `ownsChatId` before fanning out notifications.
     */
    notifyChatIds?: (string | number)[];
    adapters: {
      telegram?: Record<string, unknown>;
      slack?: Record<string, unknown>;
      discord?: Record<string, unknown>;
      [key: string]: Record<string, unknown> | undefined;
    };
  };
  voice?: {
    stt?: import("./voice/types").SttConfig;
  };
  memory?: import("./memory/types").MemoryConfig;
}

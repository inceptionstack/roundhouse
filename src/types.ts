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
  | { type: "custom_message"; customType: string; content: string };

export interface AgentAdapter {
  /** Unique agent name, e.g. "pi", "kiro" */
  name: string;

  /** Send a user message and return the full assistant response */
  prompt(threadId: string, message: AgentMessage): Promise<AgentResponse>;

  /**
   * Send a user message and stream back events in real time.
   * Falls back to prompt() if not implemented.
   */
  promptStream?(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent>;

  /** Dispose the session for a thread and start fresh on next prompt */
  restart?(threadId: string): Promise<void>;

  /** Compact the session context for a thread */
  compact?(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;

  /** Abort the current agent run for a thread */
  abort?(threadId: string): Promise<void>;

  /** Return runtime info about the agent (model, version, etc.) */
  getInfo?(threadId?: string): Record<string, unknown>;

  /** Tear down all sessions */
  dispose(): Promise<void>;
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
    allowedUsers?: string[];
    /** Immutable Telegram user IDs (paired during setup) */
    allowedUserIds?: number[];
    /** Telegram chat IDs to notify on startup */
    notifyChatIds?: number[];
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

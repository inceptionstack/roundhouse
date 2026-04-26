/**
 * types.ts — Core abstractions for roundhouse
 */

// ── Agent adapter ────────────────────────────────────

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
  prompt(threadId: string, text: string): Promise<AgentResponse>;

  /**
   * Send a user message and stream back events in real time.
   * Falls back to prompt() if not implemented.
   */
  promptStream?(threadId: string, text: string): AsyncIterable<AgentStreamEvent>;

  /** Dispose the session for a thread and start fresh on next prompt */
  restart?(threadId: string): Promise<void>;

  /** Compact the session context for a thread */
  compact?(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;

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
  agent: {
    type: string;
    [key: string]: unknown;
  };
  chat: {
    botUsername: string;
    allowedUsers?: string[];
    /** Telegram chat IDs to notify on startup */
    notifyChatIds?: (string | number)[];
    adapters: {
      telegram?: Record<string, unknown>;
      slack?: Record<string, unknown>;
      discord?: Record<string, unknown>;
      [key: string]: Record<string, unknown> | undefined;
    };
  };
}

/**
 * types.ts — Core abstractions for roundhouse
 */

// ── Agent adapter ────────────────────────────────────

export interface AgentAdapter {
  /** Unique agent name, e.g. "pi", "kiro" */
  name: string;

  /** Send a user message and return the full assistant response */
  prompt(threadId: string, text: string): Promise<AgentResponse>;

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
    adapters: {
      telegram?: Record<string, unknown>;
      slack?: Record<string, unknown>;
      discord?: Record<string, unknown>;
      [key: string]: Record<string, unknown> | undefined;
    };
  };
}

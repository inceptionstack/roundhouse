/**
 * agents/base-adapter.ts — Abstract base class for agent adapters.
 *
 * Defines the fixed interface contract that every adapter must fulfill.
 * Required methods are abstract; optional capabilities have default
 * implementations that callers can rely on.
 *
 * Each concrete adapter (PiAdapter, KiroAdapter) extends this class
 * and lives in its own directory with no cross-adapter imports.
 */

import type { AgentAdapter, AgentMessage, AgentResponse, AgentStreamEvent, AdapterInfo } from "../types.js";
export type { AdapterInfo } from "../types.js";

/**
 * Abstract base class for all agent adapters.
 *
 * Subclasses MUST implement:
 *   - name (property)
 *   - prompt()
 *   - promptStream()
 *   - dispose()
 *
 * Subclasses MAY override:
 *   - promptWithModel()  — defaults to prompt() ignoring model
 *   - restart()          — defaults to no-op
 *   - compact()          — defaults to null (not supported)
 *   - compactWithModel() — defaults to compact() ignoring model
 *   - abort()            — defaults to no-op
 *   - getInfo()          — defaults to empty object
 */
export abstract class BaseAdapter implements AgentAdapter {
  /** Unique agent type identifier, e.g. "pi", "kiro" */
  abstract readonly name: string;

  // ── Required: every adapter must implement these ─────

  /** Send a user message and return the full assistant response. */
  abstract prompt(threadId: string, message: AgentMessage): Promise<AgentResponse>;

  /** Send a user message and stream back events in real time. */
  abstract promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent>;

  /** Tear down all sessions and release resources. */
  abstract dispose(): Promise<void>;

  // ── Optional: override for adapter-specific behavior ─

  /**
   * Send a prompt using a specific model (e.g. Haiku for memory flush).
   * Default: ignores modelId, delegates to prompt().
   */
  async promptWithModel(threadId: string, message: AgentMessage, _modelId: string): Promise<AgentResponse> {
    return this.prompt(threadId, message);
  }

  /**
   * Dispose the session for a thread and start fresh on next prompt.
   * Default: no-op.
   */
  async restart(_threadId: string): Promise<void> {}

  /**
   * Compact the session context for a thread.
   * Default: returns null (not supported).
   */
  async compact(_threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
    return null;
  }

  /**
   * Compact with a specific model.
   * Default: ignores modelId, delegates to compact().
   */
  async compactWithModel(threadId: string, _modelId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
    return this.compact(threadId);
  }

  /**
   * Abort the current agent run for a thread.
   * Default: no-op.
   */
  async abort(_threadId: string): Promise<void> {}

  /**
   * Return runtime info about the agent (model, version, context usage, etc.).
   * Default: returns empty object.
   */
  getInfo(_threadId?: string): AdapterInfo {
    return {};
  }
}

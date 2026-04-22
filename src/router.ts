/**
 * router.ts — Agent routing
 *
 * Today: SingleAgentRouter — all threads go to one agent.
 * Future: swap in MultiAgentRouter, UserChoiceRouter, etc.
 */

import type { AgentAdapter, AgentRouter } from "./types";

/**
 * Routes every thread to the single configured agent.
 * This is the default and only router for now.
 */
export class SingleAgentRouter implements AgentRouter {
  constructor(private agent: AgentAdapter) {}

  resolve(_threadId: string): AgentAdapter {
    return this.agent;
  }

  async dispose(): Promise<void> {
    await this.agent.dispose();
  }
}

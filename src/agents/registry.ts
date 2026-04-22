/**
 * agents/registry.ts — Agent adapter registry
 *
 * Maps agent type names to their factory functions.
 * Add new agents here.
 */

import type { AgentAdapterFactory } from "../types";
import { createPiAgentAdapter } from "./pi";

const registry = new Map<string, AgentAdapterFactory>();

registry.set("pi", createPiAgentAdapter);
// registry.set("kiro", createKiroAgentAdapter);

export function getAgentFactory(type: string): AgentAdapterFactory {
  const factory = registry.get(type);
  if (!factory) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown agent type "${type}". Available: ${available}`
    );
  }
  return factory;
}

/**
 * agents/registry.ts — Agent adapter registry
 *
 * Maps agent type names to their factory functions.
 * Add new agents here.
 */

import type { AgentAdapterFactory } from "../types";
import { createPiAgentAdapter } from "./pi";

const registry = new Map<string, AgentAdapterFactory>();
const sdkPackages = new Map<string, string>();

registry.set("pi", createPiAgentAdapter);
sdkPackages.set("pi", "@mariozechner/pi-coding-agent");
// registry.set("kiro", createKiroAgentAdapter);
// sdkPackages.set("kiro", "@kiro/...");

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

/** Get the npm package name for an agent type's SDK (for version display) */
export function getAgentSdkPackage(type: string): string | undefined {
  return sdkPackages.get(type);
}

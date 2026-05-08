/**
 * agents/index.ts — Public API for the agents subsystem.
 */

export { BaseAdapter } from "./base-adapter.js";
export { getAgentDefinition, getAgentFactory, listAvailableAgentTypes, isKnownAgentType, getAgentSdkPackage } from "./registry.js";
export type { AgentDefinition, AgentPackageRequirement, AgentSetupContext } from "./registry.js";

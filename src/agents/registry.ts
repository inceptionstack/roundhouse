/**
 * agents/registry.ts — Agent adapter registry
 *
 * Maps agent type names to their definitions including factory, install
 * requirements, config defaults, and doctor checks.
 */

import type { AgentAdapterFactory } from "../types";
import { createPiAgentAdapter } from "./pi";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────

export interface AgentPackageRequirement {
  /** Human-readable label (defaults to packageName) */
  name?: string;
  /** npm package to install */
  packageName: string;
  /** Install scope */
  install: "global" | "local";
  /** Executable that proves the package is installed */
  binary?: string;
}

export interface AgentSetupContext {
  provider: string;
  model: string;
  cwd: string;
  force: boolean;
  psst: boolean;
  extensions: string[];
}

export interface AgentDefinition {
  /** Stable config/CLI type, e.g. "pi" */
  type: string;
  /** Display name, e.g. "Pi" */
  name: string;
  /** Runtime adapter factory */
  factory?: AgentAdapterFactory;
  /** Can users select this today? */
  available: boolean;
  /** Packages setup should install */
  packages: AgentPackageRequirement[];
  /** Package used for version display */
  sdkPackage?: string;
  /** Default config merged into gatewayConfig.agent */
  configDefaults: Record<string, unknown>;
  /** Dirs to create during preflight */
  configDirs?: string[];
  /** Agent-specific config writer */
  configure?: (ctx: AgentSetupContext) => Promise<void>;
  /** Agent-specific extension installer */
  installExtension?: (ext: string) => Promise<void>;
  /** Agent-specific doctor checks (future: loaded dynamically by doctor runner) */
  doctorChecks?: unknown[];
}

// ── Pi Definition ────────────────────────────────────


const piDefinition: AgentDefinition = {
  type: "pi",
  name: "Pi",
  factory: createPiAgentAdapter,
  available: true,
  packages: [
    {
      name: "Pi coding agent",
      packageName: "@mariozechner/pi-coding-agent",
      install: "global",
      binary: "pi",
    },
  ],
  sdkPackage: "@mariozechner/pi-coding-agent",
  configDefaults: {},
  configDirs: [resolve(homedir(), ".pi", "agent")],
  // configure and installExtension are set by setup.ts since they need
  // setup-specific helpers (execOrFail, atomicWriteJson, etc.)
};

// ── Registry ─────────────────────────────────────────

const definitions = new Map<string, AgentDefinition>();
definitions.set("pi", piDefinition);

// Future:
// definitions.set("kiro", kiroDefinition);

// ── Public API ───────────────────────────────────────

export function getAgentDefinition(type: string): AgentDefinition {
  const def = definitions.get(type);
  if (!def) {
    const available = listAvailableAgentTypes().join(", ");
    throw new Error(`Unknown agent type "${type}". Available: ${available}`);
  }
  if (!def.available) {
    throw new Error(`Agent type "${type}" is not yet available.`);
  }
  return def;
}

export function listAvailableAgentTypes(): string[] {
  return [...definitions.values()].filter(d => d.available).map(d => d.type);
}

/** Check if an agent type is registered (for future plugin validation) */
export function isKnownAgentType(type: string): boolean {
  return definitions.has(type);
}

/** Get the runtime adapter factory for an agent type */
export function getAgentFactory(type: string): AgentAdapterFactory {
  const def = getAgentDefinition(type);
  if (!def.factory) {
    throw new Error(`Agent type "${type}" has no runtime adapter.`);
  }
  return def.factory;
}

/** Get the npm package name for an agent type's SDK (for version display) */
export function getAgentSdkPackage(type: string): string | undefined {
  return definitions.get(type)?.sdkPackage;
}

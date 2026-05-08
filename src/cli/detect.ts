/**
 * detect.ts — Agent environment detection for setup wizard
 *
 * Detects which agent backends are available on the system
 * so setup can skip unnecessary installs and offer smart defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { whichSync } from "./systemd";

// ── Types ────────────────────────────────────────────

export interface DetectedAgent {
  type: "pi" | "kiro" | "openclaw";
  binary: string | null;       // Path to binary (null if not found)
  version: string | null;      // Version string (null if couldn't determine)
  configured: boolean;         // Has config/settings present
  details: Record<string, string>;  // Extra info (provider, model, etc.)
}

export interface DetectedEnvironment {
  agents: DetectedAgent[];
  recommended: "pi" | "kiro" | "openclaw" | null;
}

// ── Detection ────────────────────────────────────────

function detectPi(): DetectedAgent | null {
  const binary = whichSync("pi");
  if (!binary) return null;

  let version: string | null = null;
  try {
    
    version = execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}

  const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
  let configured = false;
  const details: Record<string, string> = {};

  if (existsSync(settingsPath)) {
    configured = true;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (settings.defaultProvider) details.provider = settings.defaultProvider;
      if (settings.defaultModel) details.model = settings.defaultModel;
    } catch {}
  }

  return { type: "pi", binary, version, configured, details };
}

function detectKiro(): DetectedAgent | null {
  const binary = whichSync("kiro-cli");
  if (!binary) return null;

  let version: string | null = null;
  try {
    
    version = execFileSync("kiro-cli", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}

  // Check for kiro config directory
  const configDir = resolve(homedir(), ".kiro");
  const configured = existsSync(configDir);
  return { type: "kiro", binary, version, configured, details: {} };
}

function detectOpenClaw(): DetectedAgent | null {
  const binary = whichSync("oc");
  if (!binary) return null;

  let version: string | null = null;
  try {
    
    version = execFileSync("oc", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}

  const configPath = resolve(homedir(), ".openclaw", "openclaw.json");
  let configured = false;
  const details: Record<string, string> = {};

  if (existsSync(configPath)) {
    configured = true;
    // Check if gateway is configured
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.gateway?.port) details.port = String(config.gateway.port);
    } catch {}
  }

  return { type: "openclaw", binary, version, configured, details };
}

// ── Public API ───────────────────────────────────────

/**
 * Detect which agent backends are available on the system.
 * Returns all detected agents and a recommended default.
 */
export function detectEnvironment(): DetectedEnvironment {
  const agents: DetectedAgent[] = [];

  const pi = detectPi();
  if (pi) agents.push(pi);

  const kiro = detectKiro();
  if (kiro) agents.push(kiro);

  const oc = detectOpenClaw();
  if (oc) agents.push(oc);

  // Recommendation: prefer configured agent, then Pi as default
  let recommended: DetectedEnvironment["recommended"] = null;
  const configured = agents.filter(a => a.configured);
  if (configured.length === 1) {
    recommended = configured[0].type;
  } else if (configured.length > 1) {
    // Multiple configured — prefer Pi (most common for roundhouse)
    recommended = configured.find(a => a.type === "pi")?.type ?? configured[0].type;
  } else if (agents.length === 1) {
    recommended = agents[0].type;
  }

  return { agents, recommended };
}

/**
 * Format detection results for display in setup output.
 */
export function formatDetectionResults(env: DetectedEnvironment): string[] {
  const lines: string[] = [];

  if (env.agents.length === 0) {
    lines.push("No agent backends detected (will install Pi)");
    return lines;
  }

  for (const agent of env.agents) {
    const ver = agent.version ? ` (${agent.version})` : "";
    const status = agent.configured ? "configured" : "found";
    let line = `${agent.type}${ver} — ${status}`;
    if (agent.details.provider) line += ` [${agent.details.provider}]`;
    if (agent.details.model) line += ` [${agent.details.model}]`;
    lines.push(line);
  }

  if (env.recommended) {
    lines.push(`→ Using: ${env.recommended}`);
  }

  return lines;
}

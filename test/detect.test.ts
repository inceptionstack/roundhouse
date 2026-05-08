import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectEnvironment, formatDetectionResults, type DetectedEnvironment } from "../src/cli/detect";

// Mock whichSync and fs
vi.mock("../src/cli/systemd", () => ({
  whichSync: vi.fn(() => null),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "v1.0.0"),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
  };
});

import { whichSync } from "../src/cli/systemd";
import { existsSync, readFileSync } from "node:fs";

describe("detectEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty agents when nothing found", () => {
    const env = detectEnvironment();
    expect(env.agents).toEqual([]);
    expect(env.recommended).toBeNull();
  });

  it("detects pi when binary exists", () => {
    vi.mocked(whichSync).mockImplementation((cmd) => cmd === "pi" ? "/usr/bin/pi" : null);
    const env = detectEnvironment();
    expect(env.agents).toHaveLength(1);
    expect(env.agents[0].type).toBe("pi");
    expect(env.agents[0].binary).toBe("/usr/bin/pi");
    expect(env.recommended).toBe("pi");
  });

  it("detects pi as configured when settings.json exists", () => {
    vi.mocked(whichSync).mockImplementation((cmd) => cmd === "pi" ? "/usr/bin/pi" : null);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      defaultProvider: "amazon-bedrock",
      defaultModel: "claude-opus-4-6",
    }));

    const env = detectEnvironment();
    expect(env.agents[0].configured).toBe(true);
    expect(env.agents[0].details.provider).toBe("amazon-bedrock");
    expect(env.agents[0].details.model).toBe("claude-opus-4-6");
  });

  it("detects kiro when binary exists", () => {
    vi.mocked(whichSync).mockImplementation((cmd) => cmd === "kiro" ? "/usr/bin/kiro" : null);
    const env = detectEnvironment();
    expect(env.agents).toHaveLength(1);
    expect(env.agents[0].type).toBe("kiro");
    expect(env.recommended).toBe("kiro");
  });

  it("detects openclaw when oc binary exists", () => {
    vi.mocked(whichSync).mockImplementation((cmd) => cmd === "oc" ? "/usr/bin/oc" : null);
    const env = detectEnvironment();
    expect(env.agents).toHaveLength(1);
    expect(env.agents[0].type).toBe("openclaw");
    expect(env.recommended).toBe("openclaw");
  });

  it("recommends pi when multiple agents configured", () => {
    vi.mocked(whichSync).mockImplementation((cmd) => {
      if (cmd === "pi") return "/usr/bin/pi";
      if (cmd === "kiro") return "/usr/bin/kiro";
      return null;
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{}");

    const env = detectEnvironment();
    expect(env.agents).toHaveLength(2);
    expect(env.recommended).toBe("pi");
  });
});

describe("formatDetectionResults", () => {
  it("shows message when no agents detected", () => {
    const env: DetectedEnvironment = { agents: [], recommended: null };
    const lines = formatDetectionResults(env);
    expect(lines[0]).toContain("No agent backends detected");
  });

  it("formats detected agent with version and details", () => {
    const env: DetectedEnvironment = {
      agents: [{
        type: "pi",
        binary: "/usr/bin/pi",
        version: "v0.73.1",
        configured: true,
        details: { provider: "amazon-bedrock", model: "claude-opus-4-6" },
      }],
      recommended: "pi",
    };
    const lines = formatDetectionResults(env);
    expect(lines[0]).toContain("pi");
    expect(lines[0]).toContain("v0.73.1");
    expect(lines[0]).toContain("configured");
    expect(lines[0]).toContain("amazon-bedrock");
    expect(lines[1]).toContain("Using: pi");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import {
  provisionMcporter,
  provisionPlaywright,
  provisionUvx,
  provisionMcporterConfig,
  provisionBundle,
  SKILLS_DIR,
  SKILLS_REPO,
  type ProvisionLog,
} from "../src/provisioning/bundle";

// Mock child_process to control `which` checks and block real installs
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args?: string[], _opts?: any) => {
      if (cmd === "which") return `/usr/local/bin/${args?.[0] ?? "unknown"}\n`;
      // git clone for skill sync
      if (cmd === "git") return "";
      return "";
    }),
    execSync: vi.fn((_cmd: string, _opts?: any) => ""),
  };
});

describe("bundle", () => {
  function createMockLog(): ProvisionLog & { messages: string[] } {
    const messages: string[] = [];
    return {
      messages,
      info: (msg) => messages.push(`[info] ${msg}`),
      warn: (msg) => messages.push(`[warn] ${msg}`),
      ok: (msg) => messages.push(`[ok] ${msg}`),
    };
  }

  describe("SKILLS_DIR", () => {
    it("points to ~/.pi/agent/skills", () => {
      expect(SKILLS_DIR).toBe(resolve(homedir(), ".pi", "agent", "skills"));
    });
  });

  describe("SKILLS_REPO", () => {
    it("is the loki-skills GitHub URL", () => {
      expect(SKILLS_REPO).toBe("https://github.com/inceptionstack/loki-skills.git");
    });
  });

  describe("provisionMcporter", () => {
    it("skips when mcporter is already installed", () => {
      const log = createMockLog();
      provisionMcporter({ log });
      expect(log.messages.some(m => m.includes("already installed"))).toBe(true);
    });

    it("reports already installed without force", () => {
      const log = createMockLog();
      provisionMcporter({ force: false, log });
      expect(log.messages).toContain("[ok] mcporter (already installed)");
    });
  });

  describe("provisionPlaywright", () => {
    it("skips when playwright-cli is already installed", () => {
      const log = createMockLog();
      provisionPlaywright({ log });
      expect(log.messages.some(m => m.includes("already installed"))).toBe(true);
    });
  });

  describe("provisionUvx", () => {
    it("skips when uvx is already installed", () => {
      const log = createMockLog();
      provisionUvx({ log });
      expect(log.messages.some(m => m.includes("already installed"))).toBe(true);
    });
  });

  describe("provisionMcporterConfig", () => {
    const configDir = resolve(homedir(), ".mcporter");
    const configPath = resolve(configDir, "mcporter.json");
    let existed: boolean;

    beforeEach(() => {
      existed = existsSync(configPath);
      if (!existed) {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, "{}");
      }
    });

    afterEach(() => {
      if (!existed && existsSync(configPath)) {
        rmSync(configPath);
      }
    });

    it("skips when config already exists", () => {
      const log = createMockLog();
      provisionMcporterConfig({ log });
      expect(log.messages.some(m => m.includes("exists, keeping"))).toBe(true);
    });
  });

  describe("provisionBundle", () => {
    it("runs all provisioners without throwing", () => {
      const log = createMockLog();
      expect(() => provisionBundle({ log })).not.toThrow();
      expect(log.messages.length).toBeGreaterThan(3);
    });

    it("all tools report already installed when mocked", () => {
      const log = createMockLog();
      provisionBundle({ force: false, log });
      const alreadyInstalled = log.messages.filter(m => m.includes("already installed"));
      expect(alreadyInstalled.length).toBeGreaterThanOrEqual(3);
    });
  });
});

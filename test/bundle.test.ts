import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

// We test bundle.ts functions by importing them directly
import {
  syncSkillsFromRepo,
  provisionMcporter,
  provisionPlaywright,
  provisionUvx,
  provisionMcporterConfig,
  provisionBundle,
  SKILLS_DIR,
  SKILLS_REPO,
  type ProvisionLog,
  type ProvisionOpts,
} from "../src/bundle";

describe("bundle", () => {
  // Mock log that captures messages
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
      // mcporter IS installed on this machine
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
    it("skips when config already exists", () => {
      const log = createMockLog();
      // ~/.mcporter/mcporter.json exists on this machine
      provisionMcporterConfig({ log });
      expect(log.messages.some(m => m.includes("exists, keeping"))).toBe(true);
    });
  });

  describe("syncSkillsFromRepo", () => {
    it("returns a positive count when git is available", () => {
      const log = createMockLog();
      const count = syncSkillsFromRepo({ log });
      // On this machine, git is available and loki-skills has 30+ skills
      expect(count).toBeGreaterThan(0);
      expect(log.messages.some(m => m.includes("skills synced"))).toBe(true);
    });
  });

  describe("provisionBundle", () => {
    it("runs all provisioners without throwing", () => {
      const log = createMockLog();
      // Should not throw even if some provisions are no-ops
      expect(() => provisionBundle({ log })).not.toThrow();
      // Should have logged something for each provisioner
      expect(log.messages.length).toBeGreaterThan(3);
    });

    it("respects force flag", () => {
      const log = createMockLog();
      provisionBundle({ force: false, log });
      // All tools are installed on this machine, so all should say "already installed"
      const alreadyInstalled = log.messages.filter(m => m.includes("already installed"));
      expect(alreadyInstalled.length).toBeGreaterThanOrEqual(3);
    });
  });
});

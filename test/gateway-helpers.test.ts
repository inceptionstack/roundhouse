/**
 * Test that extracted gateway modules compile and export correctly.
 * These are characterization tests — they pin the API surface.
 */
import { describe, it, expect } from "vitest";
import { isCommand, isCommandWithArgs, resolveAgentThreadId, getSystemResources, toolIcon } from "../src/gateway/helpers";

describe("gateway/helpers", () => {
  describe("isCommand", () => {
    it("matches exact command", () => {
      expect(isCommand("/start", "/start", "mybot")).toBe(true);
    });

    it("matches command with bot suffix", () => {
      expect(isCommand("/start@mybot", "/start", "mybot")).toBe(true);
    });

    it("rejects command with wrong bot suffix", () => {
      expect(isCommand("/start@otherbot", "/start", "mybot")).toBe(false);
    });

    it("rejects when no bot username configured", () => {
      expect(isCommand("/start@mybot", "/start", "")).toBe(false);
    });

    it("rejects non-matching command", () => {
      expect(isCommand("/stop", "/start", "mybot")).toBe(false);
    });
  });

  describe("isCommandWithArgs", () => {
    it("matches command with space-separated args", () => {
      expect(isCommandWithArgs("/crons trigger abc", "/crons", "mybot")).toBe(true);
    });

    it("matches bare command", () => {
      expect(isCommandWithArgs("/crons", "/crons", "mybot")).toBe(true);
    });

    it("matches command with bot suffix and args", () => {
      expect(isCommandWithArgs("/crons@mybot trigger abc", "/crons", "mybot")).toBe(true);
    });
  });

  describe("resolveAgentThreadId", () => {
    it("routes private messages to main", () => {
      const thread = { id: "telegram:123" };
      const message = { chat: { type: "private" } };
      expect(resolveAgentThreadId(thread, message)).toBe("main");
    });

    it("routes group messages to group:<id>", () => {
      const thread = { id: "telegram:-100123" };
      const message = { chat: { type: "group", id: -100123 } };
      expect(resolveAgentThreadId(thread, message)).toBe("group:-100123");
    });

    it("routes telegram negative IDs to group", () => {
      const thread = { id: "telegram:-456" };
      const message = {};
      expect(resolveAgentThreadId(thread, message)).toBe("group:-456");
    });

    it("routes telegram positive IDs to main", () => {
      const thread = { id: "telegram:789" };
      const message = {};
      expect(resolveAgentThreadId(thread, message)).toBe("main");
    });
  });

  describe("getSystemResources", () => {
    it("returns expected shape", () => {
      const res = getSystemResources();
      expect(res).toHaveProperty("load1");
      expect(res).toHaveProperty("cpuCount");
      expect(res).toHaveProperty("totalGB");
      expect(res).toHaveProperty("usedGB");
      expect(res).toHaveProperty("memPct");
      expect(res).toHaveProperty("cpuPct");
      expect(typeof res.cpuCount).toBe("number");
      expect(res.cpuCount).toBeGreaterThan(0);
    });
  });

  describe("toolIcon", () => {
    it("returns known icon for bash", () => {
      expect(toolIcon("bash")).toBe("⚡");
    });

    it("returns default icon for unknown tool", () => {
      expect(toolIcon("unknown_tool")).toBe("🔧");
    });
  });
});

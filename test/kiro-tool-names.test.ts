/**
 * test/kiro-tool-names.test.ts — Tests for tool name normalization
 */

import { describe, it, expect } from "vitest";
import { normalizeToolName, toolMatches } from "../src/agents/kiro/tool-names.js";

describe("normalizeToolName", () => {
  it("strips 'Running: ' prefix", () => {
    expect(normalizeToolName("Running: ls -la")).toBe("ls -la");
  });

  it("strips 'Reading ' prefix", () => {
    expect(normalizeToolName("Reading /etc/hosts")).toBe("/etc/hosts");
  });

  it("returns raw string if no prefix matches", () => {
    expect(normalizeToolName("execute_bash")).toBe("execute_bash");
    expect(normalizeToolName("grep")).toBe("grep");
  });

  it("handles empty string", () => {
    expect(normalizeToolName("")).toBe("");
  });

  it("does not strip partial prefix matches", () => {
    expect(normalizeToolName("Run: something")).toBe("Run: something");
    expect(normalizeToolName("Read /file")).toBe("Read /file");
  });
});

describe("toolMatches", () => {
  it("'*' matches everything", () => {
    expect(toolMatches("*", "anything")).toBe(true);
    expect(toolMatches("*", "")).toBe(true);
  });

  it("exact match (case-insensitive)", () => {
    expect(toolMatches("execute_bash", "execute_bash")).toBe(true);
    expect(toolMatches("Execute_Bash", "execute_bash")).toBe(true);
    expect(toolMatches("execute_bash", "read")).toBe(false);
  });

  it("prefix glob (pattern*)", () => {
    expect(toolMatches("git*", "git_status")).toBe(true);
    expect(toolMatches("git*", "git")).toBe(true);
    expect(toolMatches("git*", "grep")).toBe(false);
  });

  it("suffix glob (*pattern)", () => {
    expect(toolMatches("*_bash", "execute_bash")).toBe(true);
    expect(toolMatches("*_bash", "run_bash")).toBe(true);
    expect(toolMatches("*_bash", "bash_run")).toBe(false);
  });

  it("contains glob (*pattern*)", () => {
    expect(toolMatches("*git*", "execute_git_status")).toBe(true);
    expect(toolMatches("*git*", "git")).toBe(true);
    expect(toolMatches("*git*", "grep")).toBe(false);
  });
});

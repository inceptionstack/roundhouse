/**
 * Characterization tests for agent-command.ts — parseAgentArgs
 */
import { describe, test, expect, vi } from "vitest";
import { parseAgentArgs } from "../src/cli/agent-command";

describe("parseAgentArgs", () => {
  test("bare prompt text captured as messageText", () => {
    const { options, useStdin } = parseAgentArgs(["hello", "world"]);
    expect(options.messageText).toBe("hello world");
    expect(useStdin).toBe(false);
  });

  test("--thread flag", () => {
    const { options } = parseAgentArgs(["--thread", "my-thread", "do stuff"]);
    expect(options.threadId).toBe("my-thread");
    expect(options.messageText).toBe("do stuff");
  });

  test("--timeout flag (seconds as integer)", () => {
    const { options } = parseAgentArgs(["--timeout", "30", "task"]);
    expect(options.timeoutMs).toBe(30000);
  });

  test("--no-timeout flag", () => {
    const { options } = parseAgentArgs(["--no-timeout", "task"]);
    expect(options.timeoutMs).toBe(0);
  });

  test("--stdin flag", () => {
    const { useStdin } = parseAgentArgs(["--stdin"]);
    expect(useStdin).toBe(true);
  });

  test("--verbose flag", () => {
    const { options } = parseAgentArgs(["--verbose", "test"]);
    expect(options.verbose).toBe(true);
  });

  test("empty args defaults to main thread", () => {
    const { options } = parseAgentArgs([]);
    expect(options.threadId).toBe("main");
    expect(options.messageText).toBe("");
  });

  test("--ephemeral generates random thread ID", () => {
    const { options } = parseAgentArgs(["--ephemeral", "one-off task"]);
    expect(options.threadId).toMatch(/^cli-\d+-[a-z0-9]+$/);
    expect(options.messageText).toBe("one-off task");
  });

  test("default timeout is 120s", () => {
    const { options } = parseAgentArgs(["hello"]);
    expect(options.timeoutMs).toBe(120000);
  });
});

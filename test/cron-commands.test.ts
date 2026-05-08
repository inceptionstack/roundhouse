/**
 * Characterization tests for cron CLI arg parsing and dispatching
 */
import { describe, test, expect } from "vitest";

// Import the parseArgs function — it's private in cron.ts, so test via module internals
// Actually test the public interface: cmdCron behavior
// For now test the dispatcher pattern by importing cron-commands directly
import { cronHelp } from "../src/cli/cron-commands";

describe("cron-commands", () => {
  test("cronHelp outputs usage text", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      cronHelp();
    } finally {
      console.log = orig;
    }
    const output = logs.join("\n");
    expect(output).toContain("roundhouse cron <command>");
    expect(output).toContain("add");
    expect(output).toContain("list");
    expect(output).toContain("delete");
    expect(output).toContain("--prompt");
    expect(output).toContain("--cron");
  });
});

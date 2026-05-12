import { describe, it, expect, vi } from "vitest";
import {
  isPreTurn,
  matchesDescriptor,
  type CommandDescriptor,
  type CommandMatchers,
} from "../src/gateway/command-registry";

// Fakes matching the real `isCommand` / `isCommandWithArgs` semantics:
// isCommand: text equals "/cmd" exactly (no trailing args)
// isCommandWithArgs: text starts with "/cmd " (with trailing args)
const fakeMatchers: CommandMatchers = {
  isCommand: (text, cmd) => text === cmd,
  isCommandWithArgs: (text, cmd) => text.startsWith(cmd + " "),
};

function makeDescriptor(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    triggers: ["/test"],
    invoke: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("command-registry", () => {
  describe("isPreTurn", () => {
    it("returns true when stage is pre-turn", () => {
      expect(isPreTurn(makeDescriptor({ stage: "pre-turn" }))).toBe(true);
    });

    it("returns false when stage is in-turn", () => {
      expect(isPreTurn(makeDescriptor({ stage: "in-turn" }))).toBe(false);
    });

    it("returns false when stage is omitted (in-turn is the default)", () => {
      expect(isPreTurn(makeDescriptor())).toBe(false);
    });
  });

  describe("matchesDescriptor", () => {
    it("matches an exact command with a single trigger", () => {
      const d = makeDescriptor({ triggers: ["/topic"] });
      expect(matchesDescriptor(d, "/topic", fakeMatchers)).toBe(true);
    });

    it("does not match when text doesn't match any trigger", () => {
      const d = makeDescriptor({ triggers: ["/topic"] });
      expect(matchesDescriptor(d, "/other", fakeMatchers)).toBe(false);
    });

    it("matches any trigger in a multi-trigger descriptor", () => {
      const d = makeDescriptor({ triggers: ["/crons", "/jobs"] });
      expect(matchesDescriptor(d, "/crons", fakeMatchers)).toBe(true);
      expect(matchesDescriptor(d, "/jobs", fakeMatchers)).toBe(true);
      expect(matchesDescriptor(d, "/cron", fakeMatchers)).toBe(false);
    });

    it("rejects args when acceptsArgs is false (default)", () => {
      const d = makeDescriptor({ triggers: ["/new"] });
      expect(matchesDescriptor(d, "/new some stuff", fakeMatchers)).toBe(false);
    });

    it("accepts args when acceptsArgs is true", () => {
      const d = makeDescriptor({ triggers: ["/model"], acceptsArgs: true });
      expect(matchesDescriptor(d, "/model sonnet", fakeMatchers)).toBe(true);
    });

    it("still matches bare command when acceptsArgs is true", () => {
      const d = makeDescriptor({ triggers: ["/model"], acceptsArgs: true });
      expect(matchesDescriptor(d, "/model", fakeMatchers)).toBe(true);
    });

    it("returns false for empty triggers", () => {
      const d = makeDescriptor({ triggers: [] });
      expect(matchesDescriptor(d, "/anything", fakeMatchers)).toBe(false);
    });

    it("calls into provided matchers (not a hardcoded implementation)", () => {
      const customMatchers: CommandMatchers = {
        isCommand: vi.fn(() => true),
        isCommandWithArgs: vi.fn(() => false),
      };
      const d = makeDescriptor({ triggers: ["/cmd"] });
      matchesDescriptor(d, "/cmd", customMatchers);
      expect(customMatchers.isCommand).toHaveBeenCalledWith("/cmd", "/cmd");
    });
  });
});

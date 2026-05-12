import { describe, it, expect, vi } from "vitest";
import {
  isPreTurn,
  matchesDescriptor,
  collectAndValidateActions,
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

  describe("collectAndValidateActions", () => {
    it("returns an empty list when no descriptor has actions", () => {
      const result = collectAndValidateActions([
        makeDescriptor({ triggers: ["/a"] }),
        makeDescriptor({ triggers: ["/b"] }),
      ]);
      expect(result).toEqual([]);
    });

    it("collects all action ids in registration order", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      const result = collectAndValidateActions([
        makeDescriptor({ triggers: ["/x"], actions: { action_a: h1, action_b: h2 } }),
        makeDescriptor({ triggers: ["/y"], actions: { action_c: h3 } }),
      ]);
      expect(result.map(r => r.actionId)).toEqual(["action_a", "action_b", "action_c"]);
    });

    it("returns the owner's triggers alongside each handler", () => {
      const result = collectAndValidateActions([
        makeDescriptor({ triggers: ["/topic"], actions: { topic_select: vi.fn() } }),
      ]);
      expect(result[0]!.ownerTriggers).toEqual(["/topic"]);
    });

    it("throws on duplicate action ids across descriptors", () => {
      expect(() => collectAndValidateActions([
        makeDescriptor({ triggers: ["/first"], actions: { shared_id: vi.fn() } }),
        makeDescriptor({ triggers: ["/second"], actions: { shared_id: vi.fn() } }),
      ])).toThrow(/duplicate action id 'shared_id'/);
    });

    it("includes both owners' triggers in the error message for diagnosis", () => {
      try {
        collectAndValidateActions([
          makeDescriptor({ triggers: ["/first"], actions: { shared_id: vi.fn() } }),
          makeDescriptor({ triggers: ["/second", "/alt"], actions: { shared_id: vi.fn() } }),
        ]);
        expect.fail("should have thrown");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("/first");
        expect(msg).toContain("/second");
        expect(msg).toContain("/alt");
      }
    });

    it("allows the same action id on a single descriptor's multiple entries? no — JS object keys dedupe, but throws for two descriptors", () => {
      // This is really just documenting behavior: one descriptor can't have
      // the same key twice in its object literal (JS collapses them), so the
      // only failure mode is across descriptors.
      const h = vi.fn();
      const result = collectAndValidateActions([
        makeDescriptor({ triggers: ["/solo"], actions: { only_id: h } }),
      ]);
      expect(result).toHaveLength(1);
    });
  });
});

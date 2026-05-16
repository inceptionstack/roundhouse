/**
 * test for src/transports/rich-helpers.ts — buildSelectableMenu()
 *
 * Pins the shared "pick one" picker contract used by /model and /topic:
 *   - selected marker on the current option
 *   - sentinel renders, with active flag tracking the right state
 *   - text fallback mentions every option + the current selection
 *   - columns hint propagates to the section
 */

import { describe, it, expect } from "vitest";
import { buildSelectableMenu } from "../src/transports/rich-helpers";

describe("buildSelectableMenu", () => {
  it("marks the current option as selected", () => {
    const r = buildSelectableMenu({
      current: "b",
      options: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "c", label: "C" },
      ],
      actionId: "pick",
      textHeader: "*Current:* `b`",
    });
    const buttons = r.menu!.sections[0].buttons;
    const byKey = Object.fromEntries(buttons.map((b) => [b.value, b]));
    expect(byKey.b.selected).toBe(true);
    expect(byKey.a.selected).toBe(false);
    expect(byKey.c.selected).toBe(false);
  });

  it("renders the sentinel button when provided, with activeWhenCurrentIsUndefined true → selected on undefined current", () => {
    const r = buildSelectableMenu({
      current: undefined,
      options: [{ key: "deploy", label: "deploy" }],
      actionId: "topic",
      textHeader: "*Current:* main",
      sentinel: {
        label: "main (default)",
        value: "-main",
        activeWhenCurrentIsUndefined: true,
      },
    });
    const buttons = r.menu!.sections[0].buttons;
    expect(buttons[0].label).toBe("main (default)");
    expect(buttons[0].value).toBe("-main");
    expect(buttons[0].selected).toBe(true);
    // Real options come after sentinel.
    expect(buttons[1].value).toBe("deploy");
    expect(buttons[1].selected).toBe(false);
  });

  it("sentinel is inactive when a non-undefined current is set", () => {
    const r = buildSelectableMenu({
      current: "deploy",
      options: [{ key: "deploy", label: "deploy" }],
      actionId: "topic",
      textHeader: "*Current:* deploy",
      sentinel: {
        label: "main (default)",
        value: "-main",
        activeWhenCurrentIsUndefined: true,
      },
    });
    const [sentinelBtn, deployBtn] = r.menu!.sections[0].buttons;
    expect(sentinelBtn.selected).toBe(false);
    expect(deployBtn.selected).toBe(true);
  });

  it("text fallback mentions all option keys and the current one", () => {
    const r = buildSelectableMenu({
      current: "sonnet",
      options: [
        { key: "opus", label: "Claude Opus" },
        { key: "sonnet", label: "Claude Sonnet" },
        { key: "haiku", label: "Claude Haiku" },
      ],
      actionId: "model",
      textHeader: "🤖 *Current model:* Claude Sonnet",
      textHint: "_Usage:_ `/model sonnet`",
    });
    expect(r.text).toContain("opus");
    expect(r.text).toContain("sonnet");
    expect(r.text).toContain("haiku");
    // Current marker ("(current)") attached to the active option.
    expect(r.text).toMatch(/sonnet[^\n]*\(current\)/);
    // Hint propagates.
    expect(r.text).toContain("/model sonnet");
    // Header propagates.
    expect(r.text).toContain("🤖 *Current model:* Claude Sonnet");
  });

  it("propagates the columns hint to the menu section (default 2)", () => {
    const r2 = buildSelectableMenu({
      current: undefined,
      options: [{ key: "x", label: "X" }],
      actionId: "a",
      textHeader: "h",
    });
    expect(r2.menu!.sections[0].columns).toBe(2);

    const r1 = buildSelectableMenu({
      current: undefined,
      options: [{ key: "x", label: "X" }],
      actionId: "a",
      textHeader: "h",
      columns: 1,
    });
    expect(r1.menu!.sections[0].columns).toBe(1);

    const r3 = buildSelectableMenu({
      current: undefined,
      options: [{ key: "x", label: "X" }],
      actionId: "a",
      textHeader: "h",
      columns: 3,
    });
    expect(r3.menu!.sections[0].columns).toBe(3);
  });

  it("uses the provided actionId on every button", () => {
    const r = buildSelectableMenu({
      current: undefined,
      options: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      actionId: "my_action",
      textHeader: "h",
      sentinel: { label: "s", value: "-s" },
    });
    for (const btn of r.menu!.sections[0].buttons) {
      expect(btn.actionId).toBe("my_action");
    }
  });

  it("emits no '*Available:*' block when there are no options", () => {
    const r = buildSelectableMenu({
      current: undefined,
      options: [],
      actionId: "a",
      textHeader: "*No topics yet*",
      textHint: "Create with /foo bar",
      sentinel: { label: "main", value: "-main", activeWhenCurrentIsUndefined: true },
    });
    expect(r.text).not.toContain("*Available:*");
    // But the sentinel button is still rendered.
    expect(r.menu!.sections[0].buttons).toHaveLength(1);
  });
});

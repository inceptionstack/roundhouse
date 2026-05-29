/**
 * test/slack-format.test.ts — slack format helpers + richMenuToCard
 */

import { describe, it, expect } from "vitest";
import { isSlackChatId, SLACK_MARKDOWN_TEXT_LIMIT } from "../src/transports/slack/format";
import { richMenuToCard, stripMarkdownToPlain } from "../src/transports/rich-helpers";

describe("isSlackChatId", () => {
  it.each([
    ["C01ABC", true],
    ["D01XYZ", true],
    ["G01PRIV", true],
    ["U02USER", true],
    ["12345", false],
    ["-100123", false],
    ["c01abc", false],   // lowercase → not a Slack id
    [12345, false],
    ["", false],
  ])("isSlackChatId(%j) === %s", (id, expected) => {
    expect(isSlackChatId(id as any)).toBe(expected);
  });

  it("SLACK_MARKDOWN_TEXT_LIMIT is the documented 12k cap", () => {
    expect(SLACK_MARKDOWN_TEXT_LIMIT).toBe(12_000);
  });
});

describe("richMenuToCard", () => {
  it("emits a CardElement with action blocks (NOT raw Block Kit)", () => {
    const card = richMenuToCard(
      {
        sections: [
          {
            title: "Pick:",
            buttons: [
              { label: "Yes", actionId: "decide", value: "yes" },
              { label: "No", actionId: "decide", value: "no", selected: true },
            ],
          },
        ],
      },
      "Header text"
    );

    expect(card.type).toBe("card");
    expect(Array.isArray(card.children)).toBe(true);
    // First section is the optional header prose.
    const headerSection = (card.children[0] as any);
    expect(headerSection.type).toBe("section");
    // Second section has the title + actions.
    const buttonSection = (card.children[1] as any);
    const actions = buttonSection.children.find((c: any) => c.type === "actions");
    expect(actions).toBeDefined();
    expect(actions.children.length).toBe(2);
    expect(actions.children[0].id).toBe("decide");
    expect(actions.children[0].value).toBe("yes");
    expect(actions.children[1].style).toBe("primary");   // selected: true
  });

  it("chunks button groups at 5 (Slack actions block max)", () => {
    const buttons = Array.from({ length: 7 }, (_, i) => ({
      label: `b${i}`,
      actionId: "x",
      value: `${i}`,
    }));
    const card = richMenuToCard({ sections: [{ buttons }] });
    const section = card.children[0] as any;
    const actionBlocks = section.children.filter((c: any) => c.type === "actions");
    expect(actionBlocks.length).toBe(2);   // 5 + 2
    expect(actionBlocks[0].children.length).toBe(5);
    expect(actionBlocks[1].children.length).toBe(2);
  });
});

describe("stripMarkdownToPlain", () => {
  it("removes inline emphasis and code markers", () => {
    expect(stripMarkdownToPlain("**bold** and *italic* and `code`")).toBe(
      "bold and italic and code"
    );
  });

  it("strips fenced code fences but keeps content", () => {
    const input = "```js\nconsole.log(1)\n```";
    expect(stripMarkdownToPlain(input)).toContain("console.log(1)");
  });

  it("turns markdown links into plain link text", () => {
    expect(stripMarkdownToPlain("see [docs](https://x.com)")).toBe("see docs");
  });

  it("keeps emoji and bullets readable", () => {
    expect(stripMarkdownToPlain("- one\n- two")).toBe("• one\n• two");
  });
});

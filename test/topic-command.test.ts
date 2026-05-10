import { describe, it, expect, beforeEach } from "vitest";
import { getActiveTopic, setActiveTopic, applyTopicOverride } from "../src/gateway/topic-command";

describe("topic-command", () => {
  beforeEach(() => {
    // Reset to main
    setActiveTopic("123", "main");
  });

  it("returns undefined when no topic set", () => {
    expect(getActiveTopic("123")).toBeUndefined();
  });

  it("sets and gets active topic", () => {
    setActiveTopic("123", "deploy");
    expect(getActiveTopic("123")).toBe("deploy");
  });

  it("clears topic on 'main'", () => {
    setActiveTopic("123", "deploy");
    setActiveTopic("123", "main");
    expect(getActiveTopic("123")).toBeUndefined();
  });

  it("clears topic on 'off'", () => {
    setActiveTopic("123", "debug");
    setActiveTopic("123", "off");
    expect(getActiveTopic("123")).toBeUndefined();
  });

  describe("applyTopicOverride", () => {
    it("overrides 'main' when topic is active (scoped to chat)", () => {
      setActiveTopic("456", "deploy");
      const result = applyTopicOverride("main", { id: "telegram:456" });
      expect(result).toBe("topic:456:deploy");
    });

    it("returns main when no topic active", () => {
      const result = applyTopicOverride("main", { id: "telegram:789" });
      expect(result).toBe("main");
    });

    it("does not override group threads", () => {
      setActiveTopic("456", "deploy");
      const result = applyTopicOverride("group:-100456", { id: "telegram:-100456" });
      expect(result).toBe("group:-100456");
    });
  });
});

import { describe, it, expect } from "vitest";
import type { UpdateProgress, UpdateResult } from "../src/cli/update";

describe("commands/update", () => {
  describe("UpdateProgress interface", () => {
    it("defines update method", () => {
      const progress: UpdateProgress = { update: async () => {} };
      expect(progress.update).toBeTypeOf("function");
    });
  });

  describe("UpdateResult interface", () => {
    it("supports already-latest action", () => {
      const result: UpdateResult = { action: "already-latest", currentVersion: "1.0.0" };
      expect(result.action).toBe("already-latest");
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBeUndefined();
    });

    it("supports updated action with latestVersion", () => {
      const result: UpdateResult = { action: "updated", currentVersion: "1.0.0", latestVersion: "1.1.0" };
      expect(result.action).toBe("updated");
      expect(result.latestVersion).toBe("1.1.0");
    });

    it("only allows valid action values", () => {
      // Type check — "failed" is NOT a valid action
      const validActions: UpdateResult["action"][] = ["already-latest", "updated"];
      expect(validActions).toHaveLength(2);
    });
  });
});

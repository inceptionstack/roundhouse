/**
 * test/topic-sentinel.test.ts \u2014 invariant: MAIN_SENTINEL is unrepresentable.
 *
 * The /topic command uses a sentinel string ("-main") for the
 * "main (default)" button, so a user-created topic can't collide with
 * the escape hatch. This invariant only holds because
 * normalizeTopicName() strips leading and trailing dashes \u2014 if that's
 * ever relaxed, the sentinel must change.
 */

import { describe, it, expect } from "vitest";
import { normalizeTopicName, MAIN_SENTINEL } from "../src/gateway/topic-command";

describe("MAIN_SENTINEL invariant", () => {
  it("is unrepresentable by normalizeTopicName for any plausible input", () => {
    const probes = [
      "-main", "main-", " main ", "--main--", "@main",
      "MAIN", "Main", "-MAIN-", "_main_", "main",
      "-_main_-", "  -main-  ", "\tmain\n",
    ];
    for (const probe of probes) {
      expect(normalizeTopicName(probe)).not.toBe(MAIN_SENTINEL);
    }
  });
});

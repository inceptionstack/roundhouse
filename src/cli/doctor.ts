/**
 * cli/doctor.ts — roundhouse doctor CLI command
 */

import type { DoctorCategory } from "./doctor/types";
import { formatResult, formatSummary, formatCategoryHeader } from "./doctor/output";
import { runDoctor, createDoctorContext } from "./doctor/runner";

const CATEGORY_ORDER: DoctorCategory[] = [
  "system", "config", "credentials", "network", "agent", "stt", "disk", "systemd",
];

export async function cmdDoctor(args: string[]): Promise<void> {
  const fix = args.includes("--fix");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const json = args.includes("--json");

  const ctx = await createDoctorContext({ fix, verbose, json });

  if (!json) {
    console.log("\nRoundhouse Doctor\n");
    if (fix) console.log("  Running with --fix (will attempt to fix issues)\n");
  }

  const results = await runDoctor(ctx);

  if (json) {
    const counts = { pass: 0, warn: 0, fail: 0, info: 0, fixed: 0 };
    for (const r of results) {
      if (r.fixed) counts.fixed++;
      else counts[r.status]++;
    }
    console.log(JSON.stringify({ ok: counts.fail === 0, summary: counts, results }, null, 2));
  } else {
    for (const cat of CATEGORY_ORDER) {
      const catResults = results.filter((r) => r.category === cat);
      if (catResults.length === 0) continue;
      console.log(formatCategoryHeader(cat));
      for (const r of catResults) {
        console.log(formatResult(r, verbose));
      }
    }
    console.log(formatSummary(results));
  }

  const hasFail = results.some((r) => r.status === "fail" && !r.fixed);
  process.exit(hasFail ? 1 : 0);
}

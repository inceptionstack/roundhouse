/**
 * cli/doctor.ts — roundhouse doctor CLI command
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { DoctorContext, DoctorCategory } from "./doctor/types";
import { formatResult, formatSummary, formatCategoryHeader } from "./doctor/output";
import { runDoctor } from "./doctor/runner";
import { CONFIG_PATH, SERVICE_NAME } from "../config";

const CATEGORY_ORDER: DoctorCategory[] = [
  "system", "config", "credentials", "agent", "stt", "disk", "systemd",
];

export async function cmdDoctor(args: string[]): Promise<void> {
  const fix = args.includes("--fix");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const json = args.includes("--json");

  const ctx: DoctorContext = {
    fix,
    verbose,
    json,
    configPath: CONFIG_PATH,
    envFilePath: join(homedir(), ".config", "roundhouse", "env"),
    serviceName: SERVICE_NAME,
    now: new Date(),
    env: process.env,
  };

  if (!json) {
    console.log("\nRoundhouse Doctor\n");
    if (fix) console.log("  Running with --fix (will attempt to fix issues)\n");
  }

  const results = await runDoctor(ctx);

  // Output
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

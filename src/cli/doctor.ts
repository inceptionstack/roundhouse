/**
 * cli/doctor.ts — roundhouse doctor command
 *
 * Checks system health, configuration, credentials, agent, sessions,
 * voice/STT, systemd, disk, and permissions. Optionally fixes issues.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { DoctorCheck, DoctorCheckResult, DoctorContext, DoctorCategory } from "./doctor/types";
import { formatResult, formatSummary, formatCategoryHeader } from "./doctor/output";
import { CONFIG_PATH, SERVICE_NAME } from "../config";

// Import all check modules
import { systemChecks } from "./doctor/checks/system";
import { configChecks } from "./doctor/checks/config";
import { credentialChecks } from "./doctor/checks/credentials";
import { agentChecks } from "./doctor/checks/agent";
import { systemdChecks } from "./doctor/checks/systemd";
import { diskChecks } from "./doctor/checks/disk";
import { sttChecks } from "./doctor/checks/stt";

const ALL_CHECKS: DoctorCheck[] = [
  ...systemChecks,
  ...configChecks,
  ...credentialChecks,
  ...agentChecks,
  ...sttChecks,
  ...diskChecks,
  ...systemdChecks,
];

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

  const results: DoctorCheckResult[] = [];

  for (const check of ALL_CHECKS) {
    try {
      const result = await check.run(ctx);

      // Attempt fix if --fix and fixable
      if (fix && result.fix?.run && (result.status === "fail" || result.status === "warn")) {
        try {
          const success = await result.fix.run(ctx);
          if (success) {
            result.fixed = true;
            result.status = "pass";
            result.summary = `${result.summary} → fixed`;
          }
        } catch (err) {
          result.details = [...(result.details ?? []), `Fix failed: ${(err as Error).message}`];
        }
      }

      results.push(result);
    } catch (err) {
      results.push({
        id: check.id,
        category: check.category,
        name: check.name,
        status: "fail",
        summary: `check crashed: ${(err as Error).message}`,
      });
    }
  }

  // Output
  if (json) {
    const counts = { pass: 0, warn: 0, fail: 0, info: 0, fixed: 0 };
    for (const r of results) {
      if (r.fixed) counts.fixed++;
      else counts[r.status]++;
    }
    console.log(JSON.stringify({ ok: counts.fail === 0, summary: counts, results }, null, 2));
  } else {
    // Group by category
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

  // Exit code
  const hasFail = results.some((r) => r.status === "fail" && !r.fixed);
  process.exit(hasFail ? 1 : 0);
}

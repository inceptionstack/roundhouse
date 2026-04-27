/**
 * cli/doctor/runner.ts — Shared doctor execution logic
 *
 * Used by both CLI (cmdDoctor) and gateway (/doctor command).
 */

import type { DoctorCheck, DoctorCheckResult, DoctorContext } from "./types";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_PATH, SERVICE_NAME } from "../../config";
import { systemChecks } from "./checks/system";
import { configChecks } from "./checks/config";
import { credentialChecks } from "./checks/credentials";
import { agentChecks } from "./checks/agent";
import { systemdChecks } from "./checks/systemd";
import { diskChecks } from "./checks/disk";
import { sttChecks } from "./checks/stt";

/** Create a DoctorContext with sensible defaults */
export function createDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    fix: false,
    verbose: false,
    json: false,
    configPath: CONFIG_PATH,
    envFilePath: join(homedir(), ".config", "roundhouse", "env"),
    serviceName: SERVICE_NAME,
    now: new Date(),
    env: process.env,
    ...overrides,
  };
}

const ALL_CHECKS: DoctorCheck[] = [
  ...systemChecks,
  ...configChecks,
  ...credentialChecks,
  ...agentChecks,
  ...sttChecks,
  ...diskChecks,
  ...systemdChecks,
];

/**
 * Run all doctor checks and return results.
 * If fix=true, attempts to fix fixable issues.
 */
export async function runDoctor(ctx: DoctorContext): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  for (const check of ALL_CHECKS) {
    try {
      const result = await check.run(ctx);

      // Attempt fix if requested
      if (ctx.fix && result.fix?.run && (result.status === "fail" || result.status === "warn")) {
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

  return results;
}

/** Format results for Telegram (Markdown) — shows every check */
export function formatDoctorTelegram(results: DoctorCheckResult[]): string {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, fixed: 0 };
  for (const r of results) {
    if (r.fixed) counts.fixed++;
    else counts[r.status]++;
  }

  const STATUS_ICON: Record<string, string> = {
    pass: "✅",
    warn: "⚠️",
    fail: "❌",
    info: "ℹ️",
  };

  const lines: string[] = [
    "🩺 *Roundhouse Doctor*",
    "",
  ];

  // Status summary line
  const statusParts: string[] = [];
  if (counts.fail) statusParts.push(`❌ ${counts.fail} fail`);
  if (counts.warn) statusParts.push(`⚠️ ${counts.warn} warn`);
  if (counts.fixed) statusParts.push(`🔧 ${counts.fixed} fixed`);
  statusParts.push(`✅ ${counts.pass} pass`);
  lines.push(statusParts.join(" · "));

  // Group by category, show every check
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    lines.push("");
    lines.push(`*${capitalize(cat)}*`);
    for (const r of catResults) {
      const icon = r.fixed ? "🔧" : (STATUS_ICON[r.status] ?? "❓");
      lines.push(`${icon} ${esc(r.name)}: ${esc(r.summary)}`);

      // Show details for warnings and failures
      if ((r.status === "fail" || r.status === "warn") && r.details?.length) {
        for (const d of r.details.slice(0, 3)) {
          lines.push(`    ${esc(d)}`);
        }
      }
      if (r.fix?.command && (r.status === "fail" || r.status === "warn") && !r.fixed) {
        lines.push(`    Fix: \`${esc(r.fix.command)}\``);
      }
    }
  }

  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Escape Telegram Markdown special characters in dynamic text */
function esc(s: string): string {
  return s.replace(/([\\\[\]_*`])/g, "\\$1");
}

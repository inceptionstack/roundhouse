/**
 * cli/doctor/runner.ts — Shared doctor execution logic
 *
 * Used by both CLI (cmdDoctor) and gateway (/doctor command).
 */

import type { DoctorCheck, DoctorCheckResult, DoctorContext } from "./types";
import { systemChecks } from "./checks/system";
import { configChecks } from "./checks/config";
import { credentialChecks } from "./checks/credentials";
import { agentChecks } from "./checks/agent";
import { systemdChecks } from "./checks/systemd";
import { diskChecks } from "./checks/disk";
import { sttChecks } from "./checks/stt";

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

/** Format results for Telegram (Markdown) */
export function formatDoctorTelegram(results: DoctorCheckResult[]): string {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, fixed: 0 };
  for (const r of results) {
    if (r.fixed) counts.fixed++;
    else counts[r.status]++;
  }

  const lines: string[] = [
    "🩺 *Roundhouse Doctor*",
    "",
  ];

  // Status summary
  const statusParts: string[] = [];
  if (counts.fail) statusParts.push(`❌ ${counts.fail} fail`);
  if (counts.warn) statusParts.push(`⚠️ ${counts.warn} warn`);
  if (counts.fixed) statusParts.push(`🔧 ${counts.fixed} fixed`);
  statusParts.push(`✅ ${counts.pass} pass`);
  lines.push(statusParts.join(" · "));

  // Show failures and warnings with details
  const issues = results.filter((r) => r.status === "fail" || r.status === "warn");
  if (issues.length > 0) {
    lines.push("");
    for (const r of issues) {
      const icon = r.status === "fail" ? "❌" : "⚠️";
      lines.push(`${icon} *${capitalize(r.category)} / ${esc(r.name)}*`);
      lines.push(esc(r.summary));
      if (r.details?.length) {
        for (const d of r.details.slice(0, 3)) {
          lines.push(esc(d));
        }
      }
      if (r.fix?.command) {
        lines.push(`Fix: \`${esc(r.fix.command)}\``);
      }
      lines.push("");
    }
  }

  // Passed categories summary
  const catPasses = new Map<string, number>();
  for (const r of results) {
    if (r.status === "pass" || r.fixed) {
      catPasses.set(r.category, (catPasses.get(r.category) ?? 0) + 1);
    }
  }
  if (catPasses.size > 0) {
    const passStr = [...catPasses.entries()].map(([c, n]) => `${c} ${n}`).join(", ");
    lines.push(`✅ Passed: ${passStr}`);
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

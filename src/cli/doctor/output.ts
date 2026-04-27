/**
 * cli/doctor/output.ts — Colored output for doctor
 */

import type { DoctorCheckResult, DoctorStatus } from "./types";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY === true;
const c = (code: string, text: string) => useColor ? `${code}${text}\x1b[0m` : text;

const ICONS: Record<DoctorStatus | "fixed", string> = {
  pass: c("\x1b[32m", "[✓]"),
  warn: c("\x1b[33m", "[!]"),
  fail: c("\x1b[31m", "[✗]"),
  info: c("\x1b[36m", "[-]"),
  fixed: c("\x1b[32m", "[fixed]"),
};

export function formatResult(r: DoctorCheckResult, verbose: boolean): string {
  const icon = r.fixed ? ICONS.fixed : ICONS[r.status];
  const lines: string[] = [];
  lines.push(`    ${icon} ${r.name}: ${r.summary}`);

  if ((verbose || r.status === "fail" || r.status === "warn") && r.details?.length) {
    for (const d of r.details) {
      lines.push(`        ${d}`);
    }
  }

  if (r.fix && !r.fixed && (r.status === "fail" || r.status === "warn")) {
    if (r.fix.command) {
      lines.push(`        Fix: ${r.fix.command}`);
    }
    lines.push(`        Auto-fix: ${r.fix.run ? "yes (--fix)" : "no"}`);
  }

  return lines.join("\n");
}

export function formatSummary(results: DoctorCheckResult[]): string {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, fixed: 0 };
  for (const r of results) {
    if (r.fixed) counts.fixed++;
    else counts[r.status]++;
  }

  const parts: string[] = [];
  if (counts.fail) parts.push(c("\x1b[31m", `${counts.fail} failure(s)`));
  if (counts.warn) parts.push(c("\x1b[33m", `${counts.warn} warning(s)`));
  if (counts.fixed) parts.push(c("\x1b[32m", `${counts.fixed} fixed`));
  if (counts.pass) parts.push(c("\x1b[32m", `${counts.pass} passed`));

  return `\nDoctor found ${parts.join(", ")}.`;
}

export function formatCategoryHeader(category: string): string {
  const name = category.charAt(0).toUpperCase() + category.slice(1);
  return `\n  ${name}`;
}

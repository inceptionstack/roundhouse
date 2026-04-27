/**
 * cron/template.ts — Simple {{variable}} template renderer
 *
 * No JS eval. Unknown variables throw at validation time.
 */

import { hostname } from "node:os";

export interface TemplateContext {
  job: { id: string; description?: string };
  run: { id: string; scheduledAt: string; startedAt: string };
  date: { iso: string; local: string; localTime: string };
  timezone?: string;
  hostname: string;
  cwd: string;
  vars: Record<string, string>;
}

/** Extract all {{path.to.value}} references from a template */
export function extractTemplateVars(text: string): string[] {
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g);
  return [...matches].map((m) => m[1]);
}

/** Validate that all template variables can be resolved */
export function validateTemplate(text: string, allowedVars?: Set<string>): string[] {
  const vars = extractTemplateVars(text);
  const builtins = new Set([
    "job.id", "job.description",
    "run.id", "run.scheduledAt", "run.startedAt",
    "date.iso", "date.local", "date.localTime",
    "timezone", "hostname", "cwd",
  ]);
  const errors: string[] = [];
  for (const v of vars) {
    if (builtins.has(v)) continue;
    if (v.startsWith("vars.") && allowedVars?.has(v.slice(5))) continue;
    if (v.startsWith("vars.")) {
      errors.push(`Unknown variable: {{${v}}} — define it in job.vars`);
    } else {
      errors.push(`Unknown variable: {{${v}}}`);
    }
  }
  return errors;
}

/** Render a template with the given context */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let value: unknown = ctx;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return "";
      value = (value as Record<string, unknown>)[part];
    }
    return value != null ? String(value) : "";
  });
}

/** Build a TemplateContext for a cron run */
export function buildTemplateContext(
  jobId: string,
  jobDescription: string | undefined,
  runId: string,
  scheduledAt: Date,
  startedAt: Date,
  tz: string | undefined,
  cwd: string,
  vars: Record<string, string>,
): TemplateContext {
  const now = startedAt;
  return {
    job: { id: jobId, description: jobDescription },
    run: {
      id: runId,
      scheduledAt: scheduledAt.toISOString(),
      startedAt: startedAt.toISOString(),
    },
    date: {
      iso: now.toISOString(),
      local: now.toLocaleDateString("en-CA", { timeZone: tz || undefined }), // YYYY-MM-DD in job timezone
      localTime: now.toLocaleTimeString("en-GB", { hour12: false, timeZone: tz || undefined }),
    },
    timezone: tz,
    hostname: hostname(),
    cwd,
    vars,
  };
}

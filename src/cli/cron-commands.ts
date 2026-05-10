/**
 * cli/cron-commands.ts — Individual cron subcommand handlers
 *
 * Each handler receives store, positional args, and flags.
 * Extracted from the monolithic cmdCron switch statement.
 */

import { CronStore, validateJobId } from "../cron/store";
import { isBuiltinJob } from "../cron/helpers";
import { CronRunner } from "../cron/runner";
import { validateSchedule } from "../cron/schedule";
import { validateTemplate } from "../cron/template";
import { parseDuration } from "../cron/durations";
import type { CronJobConfig, CronSchedule } from "../cron/types";
import { DEFAULT_TIMEOUT_MS, DEFAULT_TIMEZONE, VALID_NOTIFY_ON, DEFAULT_RUNS_LIMIT } from "../cron/constants";
import { sendIpc } from "../ipc/client";

/**
 * Send a notification about a cron management action via IPC to the gateway.
 * Non-fatal — if gateway is not running, silently skip.
 */
async function notifyCronAction(message: string): Promise<void> {
  try {
    await sendIpc({ type: "notify", text: message });
  } catch {
    // Gateway not running — CLI is standalone, skip notification
  }
}
import { formatSchedule, formatRunCounts, formatJobSummary, formatJobDetail, formatRunLine, runStatusIcon, jobEnabledIcon } from "../cron/format";

function rejectBuiltin(id: string): void {
  if (isBuiltinJob(id)) {
    console.error(`Job ID "${id}" is reserved for built-in jobs.`);
    process.exit(1);
  }
}

function validateNotifyOn(value?: string): "always" | "success" | "failure" {
  const v = value ?? "always";
  if (!(VALID_NOTIFY_ON as readonly string[]).includes(v)) {
    console.error(`Invalid --notify-on: "${v}". Use ${VALID_NOTIFY_ON.join(", ")}.`);
    process.exit(1);
  }
  return v as "always" | "success" | "failure";
}

export async function cronAdd(store: CronStore, positional: string[], flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron add <id> --prompt '...' --cron '...' --tz '...'"); process.exit(1); }
  validateJobId(id);
  rejectBuiltin(id);

  const existing = await store.getJob(id);
  if (existing && !flags.replace) {
    console.error(`Job "${id}" already exists. Use --replace to overwrite.`);
    process.exit(1);
  }

  const prompt = flags.prompt;
  if (!prompt) { console.error("--prompt is required"); process.exit(1); }

  const schedCount = [flags.cron, flags.every, flags.at].filter(Boolean).length;
  if (schedCount > 1) { console.error("Specify only one of --cron, --every, or --at"); process.exit(1); }
  let schedule: CronSchedule;
  if (flags.cron) {
    schedule = { type: "cron", cron: flags.cron, tz: flags.tz ?? DEFAULT_TIMEZONE };
  } else if (flags.every) {
    schedule = { type: "interval", every: flags.every };
  } else if (flags.at) {
    schedule = { type: "once", at: flags.at, tz: flags.tz };
  } else {
    console.error("Schedule required: --cron '...', --every '...', or --at '...'");
    process.exit(1);
  }

  validateSchedule(schedule);

  const vars: Record<string, string> = {};
  if (flags.var) {
    for (const v of flags.var.split(",")) {
      const [k, ...rest] = v.split("=");
      if (k && rest.length) vars[k.trim()] = rest.join("=").trim();
    }
  }

  const templateErrors = validateTemplate(prompt, new Set(Object.keys(vars)));
  if (templateErrors.length) {
    console.error("Template errors:");
    templateErrors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }

  const notify: CronJobConfig["notify"] = {};
  if (flags.telegram) {
    notify.telegram = {
      chatIds: flags.telegram.split(",").map((s) => s.trim()),
      onlyOn: validateNotifyOn(flags["notify-on"]),
    };
  }

  const now = new Date().toISOString();
  const job: CronJobConfig = {
    id,
    enabled: true,
    description: flags.description,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    schedule,
    prompt,
    vars: Object.keys(vars).length ? vars : undefined,
    timeoutMs: flags.timeout ? parseDuration(flags.timeout) : undefined,
    notify: Object.keys(notify).length ? notify : undefined,
  };

  await store.writeJob(job);
  const verb = existing ? "updated" : "created";
  console.log(`✅ Cron job "${id}" ${verb}.`);
  if (flags.json) console.log(JSON.stringify(job, null, 2));

  const schedDesc = flags.cron ? `cron: ${flags.cron}` : flags.every ? `every ${flags.every}` : flags.at ? `once at ${flags.at}` : "";
  await notifyCronAction(`📋 Cron job **${verb}**: \`${id}\`\n${schedDesc}${flags.description ? " — " + flags.description : ""}`);
}

export async function cronList(store: CronStore, _positional: string[], flags: Record<string, string>): Promise<void> {
  let jobs = await store.listJobs();

  // Hide completed one-shot jobs unless --all flag is set
  if (!flags.all) {
    const filtered: typeof jobs = [];
    for (const j of jobs) {
      if (j.schedule.type === "once") {
        const state = await store.getState(j.id);
        if (state.totalRuns > 0) continue;
      }
      filtered.push(j);
    }
    jobs = filtered;
  }

  if (jobs.length === 0) {
    console.log("No active cron jobs.");
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    for (const j of jobs) {
      const state = await store.getState(j.id);
      console.log(`  ${formatJobSummary(j, state)}`);
    }
  }
}

export async function cronShow(store: CronStore, positional: string[], flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron show <id>"); process.exit(1); }
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }
  const state = await store.getState(id);
  const runs = await store.listRuns(id, 5);
  if (flags.json) {
    console.log(JSON.stringify({ job, state, recentRuns: runs }, null, 2));
  } else {
    console.log(`\n${formatJobDetail(job, state, runs)}`);
  }
}

export async function cronTrigger(store: CronStore, positional: string[], _flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron trigger <id>"); process.exit(1); }
  rejectBuiltin(id);
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }
  console.log(`Triggering ${id}...`);
  const runner = new CronRunner(store);
  const record = await runner.runJob(job, new Date(), "manual");
  console.log(`\nResult: ${record.status} (${record.durationMs}ms)`);
  if (record.responseText) console.log(`\n${record.responseText.slice(0, 2000)}`);
  if (record.error) console.log(`\nError: ${record.error}`);
  process.exit(record.status === "completed" ? 0 : 1);
}

export async function cronRuns(store: CronStore, positional: string[], flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron runs <id>"); process.exit(1); }
  const runs = await store.listRuns(id, parseInt(flags.limit ?? String(DEFAULT_RUNS_LIMIT), 10));
  if (runs.length === 0) {
    console.log(`No runs for ${id}.`);
  } else if (flags.json) {
    console.log(JSON.stringify(runs, null, 2));
  } else {
    for (const r of runs) {
      console.log(`  ${formatRunLine(r)} (${r.kind})`);
    }
  }
}

export async function cronPause(store: CronStore, positional: string[], _flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron pause <id>"); process.exit(1); }
  rejectBuiltin(id);
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }
  job.enabled = false;
  job.updatedAt = new Date().toISOString();
  await store.writeJob(job);
  console.log(`⏸️ Job "${id}" paused.`);
  await notifyCronAction(`⏸️ Cron job **paused**: \`${id}\``);
}

export async function cronResume(store: CronStore, positional: string[], _flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron resume <id>"); process.exit(1); }
  rejectBuiltin(id);
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }
  job.enabled = true;
  job.updatedAt = new Date().toISOString();
  await store.writeJob(job);
  console.log(`▶️ Job "${id}" resumed.`);
  await notifyCronAction(`▶️ Cron job **resumed**: \`${id}\``);
}

export async function cronEdit(store: CronStore, positional: string[], flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron edit <id> [--prompt '...'] [--cron '...'] ..."); process.exit(1); }
  rejectBuiltin(id);
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }

  if (flags.prompt) job.prompt = flags.prompt;
  if (flags.description) job.description = flags.description;
  if (flags.timeout) job.timeoutMs = parseDuration(flags.timeout);
  const editSchedCount = [flags.cron, flags.every, flags.at].filter(Boolean).length;
  if (editSchedCount > 1) { console.error("Specify only one of --cron, --every, or --at"); process.exit(1); }
  if (flags.cron) job.schedule = { type: "cron", cron: flags.cron, tz: flags.tz ?? (job.schedule.type === "cron" ? job.schedule.tz : DEFAULT_TIMEZONE) };
  if (flags.every) job.schedule = { type: "interval", every: flags.every };
  if (flags.at) job.schedule = { type: "once", at: flags.at, tz: flags.tz };
  if (flags.telegram) {
    job.notify = { ...job.notify, telegram: { chatIds: flags.telegram.split(",").map((s) => s.trim()), onlyOn: validateNotifyOn(flags["notify-on"]) } };
  }

  validateSchedule(job.schedule);
  const editVars = new Set(Object.keys(job.vars ?? {}));
  const editErrors = validateTemplate(job.prompt, editVars);
  if (editErrors.length) {
    console.error("Template errors:");
    editErrors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }
  job.updatedAt = new Date().toISOString();
  await store.writeJob(job);
  console.log(`✅ Job "${id}" updated.`);
  await notifyCronAction(`✏️ Cron job **edited**: \`${id}\``);
}

export async function cronDelete(store: CronStore, positional: string[], _flags: Record<string, string>): Promise<void> {
  const id = positional[1];
  if (!id) { console.error("Usage: roundhouse cron delete <id>"); process.exit(1); }
  rejectBuiltin(id);
  const job = await store.getJob(id);
  if (!job) { console.error(`Job not found: ${id}`); process.exit(1); }
  await store.deleteJob(id);
  console.log(`🗑️ Job "${id}" deleted.`);
  await notifyCronAction(`🗑️ Cron job **deleted**: \`${id}\``);
}

export function cronHelp(): void {
  console.log(`roundhouse cron <command>

Commands:
  add <id> [flags]    Create a cron job
  list                List all jobs
  show <id>           Show job details
  trigger <id>        Run job now
  runs <id>           Show run history
  edit <id> [flags]   Edit a job
  pause <id>          Disable a job
  resume <id>         Enable a job
  delete <id>         Delete a job

Flags for add/edit:
  --prompt "..."      Prompt template (required for add)
  --cron "..."        Cron expression (e.g. "0 8 * * *")
  --every "..."       Interval (e.g. "6h")
  --at "..."          One-shot time (e.g. "30m" or ISO date)
  --tz "..."          Timezone (e.g. "Asia/Jerusalem")
  --telegram "..."    Telegram chat IDs (comma-separated)
  --var "k=v,..."      Template variables (comma-separated)
  --timeout "..."     Timeout (e.g. "30m")
  --description "..." Job description
  --json              JSON output`);
}

/**
 * cron/runner.ts — Execute a single cron job
 *
 * Creates a fresh agent per run, renders prompt, runs with timeout,
 * saves results, notifies.
 */

import { getAgentFactory } from "../agents/registry";
import { sendTelegramToMany } from "../notify/telegram";
import { CronStore, generateRunId } from "./store";
import { buildTemplateContext, renderTemplate } from "./template";
import type { CronJobConfig, CronRunRecord } from "./types";
import { isBuiltinJob, buildCronThreadId, shouldNotify } from "./helpers";
import { DEFAULT_TIMEOUT_MS, NOTIFY_MAX_RESPONSE_CHARS, NOTIFY_MAX_ERROR_CHARS, CRON_PROMPT_SUFFIX } from "./constants";
import { runStatusIcon } from "./format";
import type { GatewayConfig } from "../types";

export class CronRunner {
  constructor(
    private store: CronStore,
    private agentConfig?: GatewayConfig["agent"],
  ) {}

  async runJob(
    job: CronJobConfig,
    scheduledAt: Date,
    kind: "scheduled" | "manual" = "scheduled",
  ): Promise<CronRunRecord> {
    const runId = generateRunId();
    const startedAt = new Date();
    const threadId = buildCronThreadId(job.id, runId);
    const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Render prompt
    const tz = job.schedule.type === "cron" ? job.schedule.tz : job.schedule.type === "once" ? job.schedule.tz : undefined;
    const agentCwd = (agentCfg.cwd as string) ?? process.cwd();
    const ctx = buildTemplateContext(job.id, job.description, runId, scheduledAt, startedAt, tz, agentCwd, job.vars ?? {});
    const prompt = renderTemplate(job.prompt, ctx) + CRON_PROMPT_SUFFIX;

    console.log(`[cron] starting ${job.id} [${runId}] kind=${kind}`);

    // Create fresh agent — use provided config or load dynamically for CLI trigger
    let agentCfg = this.agentConfig;
    if (!agentCfg) {
      const { loadConfig } = await import("../config");
      agentCfg = (await loadConfig()).agent;
    }
    const { type, ...rest } = agentCfg;
    const factory = getAgentFactory(type);
    const agent = factory({ ...rest, sessionDir: undefined });

    let responseText = "";
    let error: string | undefined;
    let status: CronRunRecord["status"] = "completed";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      // Race agent.prompt against timeout
      const result = await Promise.race([
        agent.prompt(threadId, { text: prompt }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(async () => {
            timedOut = true;
            try { await agent.abort?.(threadId); } catch {}
            reject(new Error(`Cron job timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      responseText = result.text;
    } catch (err) {
      clearTimeout(timer);
      error = (err as Error).message;
      status = timedOut ? "timeout" : "failed";
      console.error(`[cron] ${job.id} [${runId}] ${status}:`, error);
    } finally {
      try { await agent.dispose(); } catch {}
    }

    const finishedAt = new Date();
    const record: CronRunRecord = {
      id: runId, jobId: job.id, kind, status,
      scheduledAt: scheduledAt.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      threadId, prompt,
      responseText: responseText || undefined,
      error,
    };

    // Save run + update state (skip entirely for built-in jobs)
    const isBuiltin = isBuiltinJob(job.id);

    if (!isBuiltin) {
      try {
        await this.store.appendRun(record);
        const state = await this.store.getState(job.id);
        state.lastRunId = runId;
        state.lastStartedAt = startedAt.toISOString();
        state.lastFinishedAt = finishedAt.toISOString();
        state.totalRuns++;
        if (status === "completed") {
          state.lastSuccessAt = finishedAt.toISOString();
          state.totalSuccesses++;
          state.lastError = undefined;
        } else {
          state.lastFailureAt = finishedAt.toISOString();
          state.totalFailures++;
          state.lastError = error ?? status;
        }
        await this.store.writeState(state);
      } catch (err) {
        console.error(`[cron] ${job.id} [${runId}] failed to persist run:`, (err as Error).message);
      }
    }

    // Notify (catch errors)
    try { await this.notify(job, record); } catch (err) {
      console.error(`[cron] ${job.id} [${runId}] notification failed:`, (err as Error).message);
    }

    console.log(`[cron] finished ${job.id} [${runId}] status=${status} duration=${record.durationMs}ms`);
    return record;
  }

  private async notify(job: CronJobConfig, record: CronRunRecord): Promise<void> {
    const tg = job.notify?.telegram;
    if (!tg?.chatIds?.length) return;

    if (!shouldNotify(tg.onlyOn, record.status)) return;

    const icon = runStatusIcon(record.status);
    const dur = `${(record.durationMs / 1000).toFixed(1)}s`;
    const header = `${icon} Cron: ${job.id}\nStatus: ${record.status} (${dur})`;

    let body = header;
    if (record.responseText) {
      const trimmed = record.responseText.slice(0, NOTIFY_MAX_RESPONSE_CHARS);
      body = `${header}\n\n${trimmed}`;
      if (record.responseText.length > NOTIFY_MAX_RESPONSE_CHARS) body += "\n\n(truncated)";
    } else if (record.error) {
      body = `${header}\nError: ${record.error.slice(0, NOTIFY_MAX_ERROR_CHARS)}`;
    }

    await sendTelegramToMany(tg.chatIds, body);
  }
}

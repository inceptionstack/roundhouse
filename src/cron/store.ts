/**
 * cron/store.ts — Read/write cron job configs, state, and run records
 */

import { readFile, writeFile, readdir, mkdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CRON_JOBS_DIR, CRON_STATE_DIR, CRON_RUNS_DIR } from "../config";
import type { CronJobConfig, CronJobState, CronRunRecord } from "./types";

/** Atomic JSON write: write to temp file then rename. Cleans up on failure. */
async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateJobId(id: string): void {
  if (!JOB_ID_RE.test(id)) {
    throw new Error(`Invalid job ID "${id}". Use alphanumeric, dots, dashes, underscores (max 64 chars).`);
  }
}

export function generateRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomBytes(3).toString("hex")}`;
}

export class CronStore {
  async ensureDirs(): Promise<void> {
    await mkdir(CRON_JOBS_DIR, { recursive: true });
    await mkdir(CRON_STATE_DIR, { recursive: true });
    await mkdir(CRON_RUNS_DIR, { recursive: true });
  }

  async listJobs(): Promise<CronJobConfig[]> {
    try {
      const files = await readdir(CRON_JOBS_DIR);
      const jobs: CronJobConfig[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(CRON_JOBS_DIR, f), "utf8");
          jobs.push(JSON.parse(raw));
        } catch (err) {
          console.warn(`[cron/store] failed to read job ${f}:`, (err as Error).message);
        }
      }
      return jobs;
    } catch {
      return [];
    }
  }

  async getJob(id: string): Promise<CronJobConfig | null> {
    validateJobId(id);
    try {
      const raw = await readFile(join(CRON_JOBS_DIR, `${id}.json`), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writeJob(job: CronJobConfig): Promise<void> {
    validateJobId(job.id);
    await writeJsonAtomic(join(CRON_JOBS_DIR, `${job.id}.json`), job);
  }

  async deleteJob(id: string): Promise<void> {
    validateJobId(id);
    try { await unlink(join(CRON_JOBS_DIR, `${id}.json`)); } catch {}
    try { await unlink(join(CRON_STATE_DIR, `${id}.json`)); } catch {}
    try {
      const { rm } = await import("node:fs/promises");
      await rm(join(CRON_RUNS_DIR, id), { recursive: true });
    } catch {}
  }

  async getState(id: string): Promise<CronJobState> {
    validateJobId(id);
    try {
      const raw = await readFile(join(CRON_STATE_DIR, `${id}.json`), "utf8");
      return JSON.parse(raw);
    } catch {
      const { emptyState } = await import("./format");
      return emptyState(id);
    }
  }

  async writeState(state: CronJobState): Promise<void> {
    validateJobId(state.id);
    await writeJsonAtomic(join(CRON_STATE_DIR, `${state.id}.json`), state);
  }

  async appendRun(record: CronRunRecord): Promise<void> {
    validateJobId(record.jobId);
    const dir = join(CRON_RUNS_DIR, record.jobId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, `${record.id}.json`), record);
  }

  async listRuns(jobId: string, limit = 10): Promise<CronRunRecord[]> {
    validateJobId(jobId);
    const dir = join(CRON_RUNS_DIR, jobId);
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
      const runs: CronRunRecord[] = [];
      for (const f of files) {
        try {
          runs.push(JSON.parse(await readFile(join(dir, f), "utf8")));
        } catch {}
      }
      return runs;
    } catch {
      return [];
    }
  }
}

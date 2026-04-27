/**
 * cron/scheduler.ts — Internal cron scheduler
 *
 * Runs inside the gateway process. Ticks every 60s, checks for due jobs,
 * executes them serially via p-queue (concurrency: 1).
 */

import PQueue from "p-queue";
import { CronStore } from "./store";
import { CronRunner } from "./runner";
import { isDue } from "./schedule";
import type { CronJobConfig, CronJobState } from "./types";
import { TICK_MS, SHUTDOWN_TIMEOUT_MS, MAX_CATCHUP_ITERATIONS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_DEFAULT_CONTENT } from "./constants";
import { emptyState } from "./format";
import type { GatewayConfig } from "../types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROUNDHOUSE_DIR } from "../config";

export interface CronSchedulerStatus {
  running: boolean;
  jobCount: number;
  enabledCount: number;
  queueSize: number;
  queuePending: number;
  activeJobId: string | null;
}

export class CronSchedulerService {
  private store: CronStore;
  private runner: CronRunner;
  private queue: PQueue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private jobs: CronJobConfig[] = [];
  private states: Map<string, CronJobState> = new Map();
  private activeJobId: string | null = null;
  private queuedJobIds = new Set<string>(); // prevent duplicate queueing
  private ticking = false; // prevent concurrent tick invocations
  private lastHeartbeatAt = 0; // 0 = fires on first tick after startup (intentional catch-up)
  private tickMs: number;

  constructor(private opts?: { tickMs?: number; agentConfig?: GatewayConfig["agent"]; notifyChatIds?: (string | number)[] }) {
    this.store = new CronStore();
    this.runner = new CronRunner(this.store, this.opts?.agentConfig);
    this.queue = new PQueue({ concurrency: 1 });
    this.tickMs = this.opts?.tickMs ?? TICK_MS;
  }

  async start(): Promise<void> {
    await this.store.ensureDirs();
    await this.reload();
    await this.catchUp();

    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();

    console.log(`[cron] scheduler started (${this.jobs.filter((j) => j.enabled).length} enabled jobs, tick every ${this.tickMs / 1000}s)`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.clear();
    // Wait for active job with a timeout to prevent hanging shutdown
    const idle = this.queue.onIdle();
    const timeoutPromise = new Promise<void>((r) => {
      const t = setTimeout(r, SHUTDOWN_TIMEOUT_MS);
      if (t.unref) t.unref();
    });
    await Promise.race([idle, timeoutPromise]);
    console.log("[cron] scheduler stopped");
  }

  getStatus(): CronSchedulerStatus {
    return {
      running: this.timer !== null,
      jobCount: this.jobs.length,
      enabledCount: this.jobs.filter((j) => j.enabled).length,
      queueSize: this.queue.size,
      queuePending: this.queue.pending,
      activeJobId: this.activeJobId,
    };
  }

  async listJobs(): Promise<Array<{ job: CronJobConfig; state: CronJobState }>> {
    await this.reload();
    return this.jobs.map((job) => ({
      job,
      state: this.states.get(job.id) ?? emptyState(job.id),
    }));
  }

  async trigger(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId) ?? await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    this.enqueueJob(job, new Date(), "manual");
  }

  async pauseJob(jobId: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.enabled = false;
    job.updatedAt = new Date().toISOString();
    await this.store.writeJob(job);
    await this.reload();
  }

  async resumeJob(jobId: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.enabled = true;
    job.updatedAt = new Date().toISOString();
    await this.store.writeJob(job);
    await this.reload();
  }

  // ── Internal ─────────────────────────────────────

  private enqueueJob(job: CronJobConfig, dueAt: Date, kind: "scheduled" | "manual"): void {
    // Skip if already queued or running (prevent backlog for long-running jobs)
    if (kind === "scheduled" && this.queuedJobIds.has(job.id)) {
      console.log(`[cron] skipping ${job.id} — already queued or running`);
      return;
    }

    this.queuedJobIds.add(job.id);

    this.queue.add(async () => {
      this.activeJobId = job.id;
      try {
        await this.runner.runJob(job, dueAt, kind);
      } catch (err) {
        console.error(`[cron] ${job.id} run failed:`, (err as Error).message);
      } finally {
        this.activeJobId = null;
        if (job.id.startsWith("builtin-")) this.lastHeartbeatAt = Date.now();
        this.queuedJobIds.delete(job.id);
      }
    }).catch((err) => {
      console.error(`[cron] ${job.id} queue error:`, (err as Error).message);
      this.queuedJobIds.delete(job.id);
    });
  }

  private async reload(): Promise<void> {
    this.jobs = await this.store.listJobs();
    // Always refresh state from disk (runner writes updated state after each run)
    for (const job of this.jobs) {
      this.states.set(job.id, await this.store.getState(job.id));
    }
  }

  private async catchUp(): Promise<void> {
    const now = new Date();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      const catchUpMode = job.catchUp?.mode ?? "latest";
      if (catchUpMode === "none") continue;

      try {
        const state = this.states.get(job.id)!;

        // Fast-forward to latest due time (not first missed)
        // Cap iterations to prevent blocking on high-frequency schedules after long downtime
        let latestDue: Date | null = null;
        let current = isDue(job, state, now);
        let iterations = 0;
        let prevIso = "";
        while (current && iterations < MAX_CATCHUP_ITERATIONS) {
          latestDue = current;
          const currentIso = current.toISOString();
          // Break if no forward progress (e.g. once jobs always return same time)
          if (currentIso === prevIso) break;
          prevIso = currentIso;
          const tempState = { ...state, lastScheduledAt: currentIso };
          current = isDue(job, tempState, now);
          iterations++;
        }

        if (latestDue) {
          console.log(`[cron] catch-up: ${job.id} fast-forwarded to ${latestDue.toISOString()}`);
          state.lastScheduledAt = latestDue.toISOString();
          await this.store.writeState(state);
          this.enqueueJob(job, latestDue, "scheduled");
        }
      } catch (err) {
        console.error(`[cron] catch-up failed for ${job.id}:`, (err as Error).message);
      }
    }
  }

  /** Read HEARTBEAT.md and check if it has real content */
  private async readHeartbeat(): Promise<string | null> {
    try {
      const path = join(ROUNDHOUSE_DIR, "HEARTBEAT.md");
      const content = await readFile(path, "utf8");
      const trimmed = content.trim();

      // Skip if empty
      if (!trimmed) return null;

      // Skip if content matches the default template exactly
      // Normalize line endings for cross-platform compatibility
      if (trimmed.replace(/\r\n/g, "\n") === HEARTBEAT_DEFAULT_CONTENT) return null;

      return trimmed;
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn("[cron] failed to read HEARTBEAT.md:", err?.message);
      }
      return null;
    }
  }

  /** Run heartbeat if due and HEARTBEAT.md has content */
  private async checkHeartbeat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;

    const heartbeatContent = await this.readHeartbeat();
    if (!heartbeatContent) return;

    // Only advance timer when we actually have content to run.
    // Also updated in enqueueJob's finally block after completion.
    this.lastHeartbeatAt = now;

    // Create a synthetic job config for the heartbeat
    const heartbeatJob: CronJobConfig = {
      id: "builtin-heartbeat",
      enabled: true,
      description: "Built-in heartbeat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schedule: { type: "interval", every: "30m" },
      prompt: heartbeatContent,
      notify: this.getHeartbeatNotifyConfig(),
    };

    this.enqueueJob(heartbeatJob, new Date(), "scheduled");
  }

  /** Get notify config for heartbeat from gateway config's notifyChatIds */
  private getHeartbeatNotifyConfig(): CronJobConfig["notify"] {
    const chatIds = this.opts?.notifyChatIds;
    if (chatIds?.length) {
      return { telegram: { chatIds, onlyOn: "always" } };
    }
    return undefined;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // prevent concurrent ticks
    this.ticking = true;
    try {
      try {
        await this.reload();
      } catch (err) {
        console.error("[cron] reload failed:", (err as Error).message);
        return;
      }

      const now = new Date();

      for (const job of this.jobs) {
        if (!job.enabled) continue;

        try {
          const state = this.states.get(job.id)!;
          const dueAt = isDue(job, state, now);
          if (!dueAt) continue;

          // Skip if already queued — don't write state that could race with the runner
          if (this.queuedJobIds.has(job.id)) continue;

          // Update lastScheduledAt to prevent re-queueing next tick
          state.lastScheduledAt = dueAt.toISOString();
          await this.store.writeState(state);

          this.enqueueJob(job, dueAt, "scheduled");
        } catch (err) {
          console.error(`[cron] tick error for ${job.id}:`, (err as Error).message);
        }
      }

      // Check heartbeat
      await this.checkHeartbeat();
    } finally {
      this.ticking = false;
    }
  }
}

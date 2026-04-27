/**
 * cron/schedule.ts — Schedule evaluation using croner
 */

import { Cron } from "croner";
import { parseDuration, isDuration } from "./durations";
import type { CronSchedule, CronJobConfig, CronJobState } from "./types";

/** Validate a schedule config. Throws on invalid. */
export function validateSchedule(schedule: CronSchedule): void {
  switch (schedule.type) {
    case "cron": {
      try {
        const c = new Cron(schedule.cron, { timezone: schedule.tz, paused: true });
        c.stop();
      } catch (err) {
        throw new Error(`Invalid cron expression "${schedule.cron}": ${(err as Error).message}`);
      }
      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: schedule.tz });
      } catch {
        throw new Error(`Invalid timezone "${schedule.tz}"`);
      }
      break;
    }
    case "interval": {
      parseDuration(schedule.every); // throws if invalid
      break;
    }
    case "once": {
      if (isDuration(schedule.at)) {
        // relative — ok
      } else {
        const d = new Date(schedule.at);
        if (isNaN(d.getTime())) throw new Error(`Invalid date: "${schedule.at}"`);
      }
      if (schedule.tz) {
        try { Intl.DateTimeFormat(undefined, { timeZone: schedule.tz }); }
        catch { throw new Error(`Invalid timezone "${schedule.tz}"`); }
      }
      break;
    }
    default:
      throw new Error(`Unknown schedule type: ${(schedule as any).type}`);
  }
}

/** Compute the next run time after `after` for a given schedule */
export function computeNextRun(schedule: CronSchedule, after: Date): Date | null {
  switch (schedule.type) {
    case "cron": {
      const c = new Cron(schedule.cron, { timezone: schedule.tz, paused: true });
      const next = c.nextRun(after);
      c.stop();
      return next ?? null;
    }
    case "interval":
      return null; // interval uses lastScheduledAt + every
    case "once":
      return null; // once uses absolute time
    default:
      return null;
  }
}

/** Check if a job is due to run now */
export function isDue(job: CronJobConfig, state: CronJobState, now: Date): Date | null {
  if (!job.enabled) return null;

  switch (job.schedule.type) {
    case "cron": {
      const lastRun = state.lastScheduledAt ? new Date(state.lastScheduledAt) : new Date(job.createdAt);
      const c = new Cron(job.schedule.cron, { timezone: job.schedule.tz, paused: true });
      const next = c.nextRun(lastRun);
      c.stop();
      if (next && next <= now) return next;
      return null;
    }
    case "interval": {
      const everyMs = parseDuration(job.schedule.every);
      const lastRun = state.lastScheduledAt ? new Date(state.lastScheduledAt) : new Date(job.createdAt);
      const nextTime = new Date(lastRun.getTime() + everyMs);
      if (nextTime <= now) return nextTime;
      return null;
    }
    case "once": {
      if (state.totalRuns > 0) return null; // already ran
      let targetTime: Date;
      if (isDuration(job.schedule.at)) {
        targetTime = new Date(new Date(job.createdAt).getTime() + parseDuration(job.schedule.at));
      } else {
        targetTime = new Date(job.schedule.at);
      }
      if (targetTime <= now) return targetTime;
      return null;
    }
    default:
      return null;
  }
}

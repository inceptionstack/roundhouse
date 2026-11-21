/**
 * instance-lock.ts — one gateway per host
 *
 * Two gateways on one bot token both poll Telegram, so each sees part of the
 * conversation, and both write the same session files: the session forks,
 * replies come from two processes, and a compaction in one leaves the other
 * with the full context. That happened when a restart started the new gateway
 * while the old one was still finishing a turn.
 *
 * The lock file names the process that holds it (pid plus start marker, so a
 * recycled pid is not mistaken for it) and whether it is running or stopping.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROUNDHOUSE_DIR } from "./config";
import { readSpawnClockTicks, isProcessAlive } from "./subagents/pid";

export const INSTANCE_LOCK_PATH = join(ROUNDHOUSE_DIR, "gateway.lock");

interface LockRecord {
  pid: number;
  /** Start marker of `pid`, as subagents/pid reads it. */
  started: string;
  state: "running" | "stopping";
  since: string;
}

export interface InstanceLock {
  /** Tell a successor that this process is on its way out. */
  markStopping(): void;
  /** Remove the lock if this process still holds it. */
  release(): void;
}

export interface AcquireOptions {
  path?: string;
  /** How long to wait for a holder that is running before giving up (ms). */
  runningGraceMs?: number;
  /** How long to wait for a holder that is stopping before killing it (ms). */
  stoppingWaitMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
  /** Test seams. */
  isAlive?: (pid: number, started: string) => Promise<boolean>;
  kill?: (pid: number) => void;
  self?: { pid: number; started: string };
}

export class GatewayAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Another roundhouse gateway is running (pid ${pid}). Stop it first: roundhouse stop`);
    this.name = "GatewayAlreadyRunningError";
  }
}

function read(path: string): LockRecord | null {
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (typeof rec.pid === "number" && typeof rec.started === "string" && (rec.state === "running" || rec.state === "stopping")) {
      return rec as LockRecord;
    }
  } catch { /* missing or unreadable: no holder */ }
  return null;
}

function write(path: string, rec: LockRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take the gateway lock, or throw GatewayAlreadyRunningError.
 *
 *  - No holder, or the holder is gone: take it.
 *  - Holder is stopping: wait for it; if it outlives `stoppingWaitMs`, kill
 *    it. A gateway that was told to stop and did not must not keep polling.
 *  - Holder is running: give it a short grace period, in case its stop signal
 *    is still on the way (a service restart starts the new process at once),
 *    then refuse. A second gateway started by mistake must not take over.
 */
export async function acquireInstanceLock(opts: AcquireOptions = {}): Promise<InstanceLock> {
  const path = opts.path ?? INSTANCE_LOCK_PATH;
  const log = opts.log ?? ((m: string) => console.log(`[roundhouse] ${m}`));
  const alive = opts.isAlive ?? isProcessAlive;
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const poll = opts.pollMs ?? 250;
  const self = opts.self ?? { pid: process.pid, started: await readSpawnClockTicks(process.pid) };

  const start = Date.now();
  const runningGrace = opts.runningGraceMs ?? 3_000;
  const stoppingWait = opts.stoppingWaitMs ?? 15_000;
  let announced = false;

  for (;;) {
    const holder = read(path);
    if (!holder || holder.pid === self.pid || !(await alive(holder.pid, holder.started))) break;

    const waited = Date.now() - start;
    if (holder.state === "running") {
      if (waited >= runningGrace) throw new GatewayAlreadyRunningError(holder.pid);
    } else if (waited >= stoppingWait) {
      log(`previous gateway (pid ${holder.pid}) did not stop within ${Math.round(stoppingWait / 1000)}s; killing it`);
      try { kill(holder.pid); } catch { /* already gone */ }
      await sleep(Math.min(poll, 500));
      if (await alive(holder.pid, holder.started)) throw new GatewayAlreadyRunningError(holder.pid);
      break;
    }
    if (!announced) {
      announced = true;
      log(`waiting for the previous gateway (pid ${holder.pid}, ${holder.state}) to exit`);
    }
    await sleep(poll);
  }

  const mine: LockRecord = { pid: self.pid, started: self.started, state: "running", since: new Date().toISOString() };
  write(path, mine);

  const holdsLock = () => {
    const rec = read(path);
    return !!rec && rec.pid === self.pid && rec.started === self.started;
  };
  return {
    markStopping() {
      try { if (holdsLock()) write(path, { ...mine, state: "stopping", since: new Date().toISOString() }); } catch { /* best effort */ }
    },
    release() {
      try { if (holdsLock()) unlinkSync(path); } catch { /* best effort */ }
    },
  };
}

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

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
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
    super(`Another roundhouse gateway is running (pid ${pid}). Stop it first: "roundhouse stop" for the service, Ctrl+C for one started in a terminal.`);
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

/** Replace the lock's content. Only the holder calls this (state changes). */
function rewrite(path: string, rec: LockRecord): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Create the lock file if, and only if, none exists. The record is written to
 * a private file first and then hard-linked into place: the link either fails
 * because a lock exists or makes a complete lock appear at once. (Creating
 * the file and then writing to it would let another starter see it empty,
 * take it for garbage and remove it.)
 */
function createExclusive(path: string, rec: LockRecord): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.new`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/** A takeover claim older than this was left by a process that died holding it. */
const TAKEOVER_ABANDONED_MS = 10_000;

/**
 * Remove a dead holder's lock, if it is still that lock.
 *
 * Several starters can judge the same lock stale at once, and one of them may
 * already have removed it and created its own by the time another acts. So
 * removal happens under a second, short-lived claim file: whoever holds it
 * looks again and removes the lock only if it is still the record that was
 * judged stale (`expected`; null for an unreadable file). While a lock file
 * exists nobody can create another, so what the holder of the claim sees
 * cannot change under it. Returns false if the claim was busy; the caller
 * simply looks again.
 */
function clearStale(path: string, expected: LockRecord | null): boolean {
  const claim = `${path}.takeover`;
  try {
    if (Date.now() - statSync(claim).mtimeMs > TAKEOVER_ABANDONED_MS) unlinkSync(claim);
  } catch { /* no claim file */ }

  const tmp = `${claim}.${process.pid}`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, claim);
  } catch {
    return false; // another starter is clearing it right now
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }

  try {
    const now = read(path);
    const stillTheStaleOne = expected === null
      ? now === null
      : now !== null && now.pid === expected.pid && now.started === expected.started && now.since === expected.since;
    if (stillTheStaleOne) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
    return true;
  } finally {
    try { unlinkSync(claim); } catch { /* best effort */ }
  }
}

/** Whether `pid` exists at all, whatever its start marker says. */
function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
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
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const poll = opts.pollMs ?? 250;
  // Our own start marker. If it cannot be read (no `ps`, no /proc) the lock
  // still works on pid alone.
  const self = opts.self ?? { pid: process.pid, started: await readSpawnClockTicks(process.pid).catch(() => "") };

  /**
   * Is the recorded holder still that process? Errs towards "alive": taking
   * over a gateway that is in fact running is the failure this file exists to
   * prevent, while waiting on a dead one only delays a start.
   */
  const alive = opts.isAlive ?? (async (pid: number, started: string): Promise<boolean> => {
    if (!pidExists(pid)) return false;
    if (!started) return true;                       // holder had no marker: pid is all we have
    if (await isProcessAlive(pid, started)) return true;
    // The pid exists but the marker did not match, or could not be read.
    const now = await readSpawnClockTicks(pid).catch(() => undefined);
    return now === undefined ? true : now === started;
  });
  /** A lock written before this machine booted cannot belong to a live process. */
  const predatesBoot = (rec: LockRecord): boolean => {
    const since = Date.parse(rec.since);
    return Number.isFinite(since) && since < Date.now() - uptime() * 1000 - 60_000;
  };

  const start = Date.now();
  const runningGrace = opts.runningGraceMs ?? 3_000;
  const stoppingWait = opts.stoppingWaitMs ?? 15_000;
  let announced = false;
  const mine: LockRecord = { pid: self.pid, started: self.started, state: "running", since: new Date().toISOString() };

  for (;;) {
    const holder = read(path);
    const present = holder !== null || existsSync(path);
    const held = holder !== null && holder.pid !== self.pid && !predatesBoot(holder) && (await alive(holder.pid, holder.started));

    if (!held) {
      // Free, stale, unreadable, or our own leftover: clear what is there,
      // then create. Both steps are safe against another starter.
      if (present && !clearStale(path, holder)) {
        await sleep(Math.min(poll, 25));
        continue;
      }
      if (createExclusive(path, mine)) break;
      continue; // someone else created it in between: look again
    }

    const waited = Date.now() - start;
    if (holder.state === "running") {
      if (waited >= runningGrace) throw new GatewayAlreadyRunningError(holder.pid);
    } else if (waited >= stoppingWait) {
      log(`previous gateway (pid ${holder.pid}) did not stop within ${Math.round(stoppingWait / 1000)}s; killing it`);
      try { kill(holder.pid); } catch { /* already gone */ }
      await sleep(Math.min(poll, 500));
      if (await alive(holder.pid, holder.started)) throw new GatewayAlreadyRunningError(holder.pid);
      continue; // it is gone now: the next pass clears its lock and creates ours
    }
    if (!announced) {
      announced = true;
      log(`waiting for the previous gateway (pid ${holder.pid}, ${holder.state}) to exit`);
    }
    await sleep(poll);
  }

  const holdsLock = () => {
    const rec = read(path);
    return !!rec && rec.pid === self.pid && rec.started === self.started;
  };
  return {
    markStopping() {
      try { if (holdsLock()) rewrite(path, { ...mine, state: "stopping", since: mine.since }); } catch { /* best effort */ }
    },
    release() {
      try { if (holdsLock()) unlinkSync(path); } catch { /* best effort */ }
    },
  };
}

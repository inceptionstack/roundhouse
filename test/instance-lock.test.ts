/**
 * test/instance-lock.test.ts — one gateway per host.
 *
 * The cases are the ones a service restart and a mistaken second start
 * produce. Process liveness and kill are injected; nothing is signalled.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, GatewayAlreadyRunningError } from "../src/instance-lock";

let dir: string;
let path: string;
const quiet = () => {};
const me = { pid: 4242, started: "me-start" };
const record = (pid: number, started: string, state: "running" | "stopping") =>
  writeFileSync(path, JSON.stringify({ pid, started, state, since: new Date().toISOString() }));
const held = () => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rh-lock-")); path = join(dir, "gateway.lock"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("acquireInstanceLock", () => {
  it("takes a free lock and releases it", async () => {
    const lock = await acquireInstanceLock({ path, self: me, log: quiet });
    expect(held()).toMatchObject({ pid: 4242, started: "me-start", state: "running" });
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("takes over from a holder that is gone, or whose pid now belongs to another process", async () => {
    record(111, "old-start", "running");
    await acquireInstanceLock({ path, self: me, log: quiet, isAlive: async () => false });
    expect(held().pid).toBe(4242);

    record(111, "old-start", "running");
    // pid 111 is alive, but with a different start marker: a recycled pid.
    const isAlive = async (_pid: number, started: string) => started === "someone-else";
    await acquireInstanceLock({ path, self: me, log: quiet, isAlive });
    expect(held().pid).toBe(4242);
  });

  it("refuses when another gateway is running, and leaves its lock alone", async () => {
    record(111, "old-start", "running");
    const killed: number[] = [];
    await expect(acquireInstanceLock({
      path, self: me, log: quiet, isAlive: async () => true, kill: (p) => { killed.push(p); },
      runningGraceMs: 60, pollMs: 10,
    })).rejects.toBeInstanceOf(GatewayAlreadyRunningError);
    expect(held().pid).toBe(111);
    expect(killed).toEqual([]);
  });

  it("waits for a holder that is stopping, then takes over when it exits", async () => {
    record(111, "old-start", "stopping");
    let checks = 0;
    const lock = await acquireInstanceLock({
      path, self: me, log: quiet, isAlive: async () => ++checks < 4, kill: () => { throw new Error("must not kill"); },
      stoppingWaitMs: 5_000, pollMs: 5,
    });
    expect(checks).toBeGreaterThanOrEqual(4);
    expect(held().pid).toBe(4242);
    lock.release();
  });

  it("kills a holder that was told to stop and did not, then takes over", async () => {
    record(111, "old-start", "stopping");
    let alive = true;
    const killed: number[] = [];
    await acquireInstanceLock({
      path, self: me, log: quiet, isAlive: async () => alive, kill: (p) => { killed.push(p); alive = false; },
      stoppingWaitMs: 40, pollMs: 10,
    });
    expect(killed).toEqual([111]);
    expect(held().pid).toBe(4242);
  });

  it("gives a running holder a moment to start stopping (service restart starts the successor at once)", async () => {
    record(111, "old-start", "running");
    let alive = true;
    setTimeout(() => record(111, "old-start", "stopping"), 20);
    setTimeout(() => { alive = false; }, 60);
    await acquireInstanceLock({
      path, self: me, log: quiet, isAlive: async () => alive, kill: () => { throw new Error("must not kill"); },
      runningGraceMs: 500, stoppingWaitMs: 5_000, pollMs: 5,
    });
    expect(held().pid).toBe(4242);
  });

  it("markStopping and release act only on a lock this process still holds", async () => {
    const lock = await acquireInstanceLock({ path, self: me, log: quiet });
    lock.markStopping();
    expect(held().state).toBe("stopping");
    record(999, "successor", "running"); // a successor took over
    lock.markStopping();
    lock.release();
    expect(held()).toMatchObject({ pid: 999, state: "running" });
  });

  it("treats an unreadable lock file as no holder", async () => {
    writeFileSync(path, "{not json");
    await acquireInstanceLock({ path, self: me, log: quiet });
    expect(held().pid).toBe(4242);
  });
});

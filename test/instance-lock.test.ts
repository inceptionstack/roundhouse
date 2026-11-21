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
import { pathToFileURL } from "node:url";
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

describe("acquireInstanceLock with real processes", () => {
  // Several gateways started at the same instant: exactly one may hold the lock.
  // Each child is a real process that acquires with the default liveness check.
  const child = `
    import { acquireInstanceLock } from ${JSON.stringify(join(process.cwd(), "src/instance-lock.ts"))};
    const [path, at] = process.argv.slice(2);
    while (Date.now() < Number(at)) {}
    try {
      await acquireInstanceLock({ path, log: () => {}, runningGraceMs: 400, pollMs: 20 });
      console.log("ACQUIRED");
    } catch (err) {
      console.log("REFUSED " + err.name);
    }
    setInterval(() => {}, 1000); // stay alive (a winner keeps holding) until the test ends us
  `;

  async function race(n: number, prepare?: () => void): Promise<string[]> {
    const { spawn } = await import("node:child_process");
    const script = join(dir, "child.mts");
    writeFileSync(script, child);
    prepare?.();
    const at = Date.now() + 2500; // aim for a simultaneous start; a late child still gets a valid answer
    // Load tsx as a loader in the child itself. Its CLI would start the script
    // in a grandchild, which outlives a kill of the process spawned here.
    const loader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;
    const children = Array.from({ length: n }, () => spawn(process.execPath, ["--import", loader, script, path, String(at)], { stdio: ["ignore", "pipe", "ignore"] }));
    try {
      // Every child reports once; nobody exits before all have, so a winner
      // cannot leave and make room for a slow starter.
      return await Promise.all(children.map((p) => new Promise<string>((resolve) => {
        let out = "";
        p.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(out.trim()); });
        p.on("close", () => resolve(out.trim()));
      })));
    } finally {
      for (const p of children) p.kill("SIGKILL");
    }
  }

  it("lets exactly one of six simultaneous starters in when the lock is free", async () => {
    const results = await race(6);
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(1);
    expect(results.filter((r) => r === "REFUSED GatewayAlreadyRunningError")).toHaveLength(5);
  }, 20_000);

  it("lets exactly one in when they all find the same stale lock", async () => {
    const results = await race(6, () => record(999_999, "long gone", "running"));
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(1);
    expect(results.filter((r) => r === "REFUSED GatewayAlreadyRunningError")).toHaveLength(5);
  }, 20_000);
});

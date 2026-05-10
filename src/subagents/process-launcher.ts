import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { readSpawnClockTicks as defaultReadSpawnClockTicks } from "./pid";

export interface LaunchResult {
  child: ChildProcess;
  pid: number;
  spawnClockTicks: string;
}

export interface ProcessLauncherOptions {
  spawnProcess?: typeof spawn;
  checkPiAvailable?: () => void;
  readSpawnClockTicks?: (pid: number) => Promise<string>;
  signalProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

export class ProcessLauncher {
  private readonly spawnProcess: typeof spawn;
  private readonly checkPiAvailable: () => void;
  private readonly readSpawnClockTicksFn: (pid: number) => Promise<string>;
  readonly signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;

  constructor(options: ProcessLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.checkPiAvailable = options.checkPiAvailable ?? defaultPiAvailabilityCheck;
    this.readSpawnClockTicksFn = options.readSpawnClockTicks ?? defaultReadSpawnClockTicks;
    this.signalProcess = options.signalProcess ?? defaultSignalProcess;
  }

  assertAvailable(): void {
    this.checkPiAvailable();
  }

  async launch(runDir: string, cwd: string, onChildCreated?: (child: ChildProcess) => void): Promise<LaunchResult> {
    const stdoutHandle = await open(join(runDir, "stdout.log"), "a");
    const stderrHandle = await open(join(runDir, "stderr.log"), "a");
    let child: ChildProcess | undefined;

    try {
      child = this.spawnProcess("pi", ["--session-dir", runDir, "--brief-file", join(runDir, "brief.md")], {
        cwd,
        detached: true,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      });
      onChildCreated?.(child);

      await waitForChildSpawn(child);

      if (typeof child.pid !== "number") {
        throw new Error("Sub-agent process did not expose a PID");
      }

      const spawnClockTicks = await this.readSpawnClockTicksFn(child.pid);
      child.unref();

      return { child, pid: child.pid, spawnClockTicks };
    } catch (err) {
      if (typeof child?.pid === "number") {
        try {
          this.signalProcess(child.pid, "SIGTERM");
        } catch {}
      }
      throw err;
    } finally {
      await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
    }
  }
}

function defaultPiAvailabilityCheck(): void {
  if (piAvailableCache !== undefined) {
    if (!piAvailableCache) throw new Error("pi executable not found in PATH");
    return;
  }
  try {
    execFileSync("which", ["pi"], { stdio: "pipe" });
    piAvailableCache = true;
  } catch {
    piAvailableCache = false;
    throw new Error("pi executable not found in PATH");
  }
}

let piAvailableCache: boolean | undefined;

function defaultSignalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(pid, signal);
}

async function waitForChildSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off("spawn", onSpawn);
      reject(err);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

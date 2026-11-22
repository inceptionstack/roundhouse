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

  async launch(
    runDir: string,
    cwd: string,
    onChildCreated?: (child: ChildProcess) => void,
    tools?: readonly string[],
  ): Promise<LaunchResult> {
    const stdoutHandle = await open(join(runDir, "stdout.log"), "a");
    const stderrHandle = await open(join(runDir, "stderr.log"), "a");
    let child: ChildProcess | undefined;

    try {
      child = this.spawnProcess("pi", [
        "--no-extensions", "--no-skills",
        ...toolArgs(tools),
        "--session-dir", runDir, "-p", `@${join(runDir, "brief.md")}`,
      ], {
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

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * pi's flags for a run limited to the named tools. `--tools` replaces pi's
 * default set (read, bash, edit, write) and keeps MCP tools, so MCP goes off
 * too: a reader must not reach anything through a server. Names are checked
 * because they end up on a command line.
 */
export function toolArgs(tools?: readonly string[]): string[] {
  if (!tools) return [];
  if (tools.length === 0) return ["--no-tools", "--no-mcp"];
  for (const t of tools) {
    if (!TOOL_NAME_RE.test(t)) throw new Error(`Invalid sub-agent tool name: ${JSON.stringify(t)}`);
  }
  return ["--tools", tools.join(","), "--no-mcp"];
}

function defaultPiAvailabilityCheck(): void {
  if (piAvailableCache === true) return;
  // No negative caching — retry on every spawn so installing pi mid-session works
  try {
    execFileSync("which", ["pi"], { stdio: "pipe" });
    piAvailableCache = true;
  } catch {
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

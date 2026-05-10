import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "./brief";
import { isProcessAlive, readSpawnClockTicks } from "./pid";
import type { RunStatus, SpawnSpec, SubAgentLifecycle, SubAgentOrchestrator } from "./types";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type TerminalStatus = Exclude<RunStatus["status"], "running">;
type CompletionListener = (status: RunStatus) => Promise<void> | void;

interface OrchestratorOptions {
  dataRoot?: string;
  spawnProcess?: typeof spawn;
  checkPiAvailable?: () => void;
  readSpawnClockTicks?: (pid: number) => Promise<string>;
  isProcessAlive?: (pid: number, expectedTicks: string) => Promise<boolean>;
  signalProcess?: (pid: number, signal: "SIGTERM") => void;
  now?: () => Date;
}

export class SubAgentOrchestratorImpl implements SubAgentOrchestrator, SubAgentLifecycle {
  private readonly dataRoot: string;
  private readonly subagentsRoot: string;
  private readonly spawnProcess: typeof spawn;
  private readonly checkPiAvailable: () => void;
  private readonly readSpawnClockTicks: (pid: number) => Promise<string>;
  private readonly isProcessAlive: (pid: number, expectedTicks: string) => Promise<boolean>;
  private readonly signalProcess: (pid: number, signal: "SIGTERM") => void;
  private readonly now: () => Date;
  private readonly children = new Map<string, ChildProcess>();
  private readonly pendingTerminalStatus = new Map<string, TerminalStatus>();
  private readonly completionListeners = new Set<CompletionListener>();
  private readonly statusReady = new Map<string, Promise<void>>();

  constructor(options: OrchestratorOptions = {}) {
    this.dataRoot = options.dataRoot ?? join(homedir(), ".roundhouse");
    this.subagentsRoot = join(this.dataRoot, "subagents");
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.checkPiAvailable = options.checkPiAvailable ?? defaultPiAvailabilityCheck;
    this.readSpawnClockTicks = options.readSpawnClockTicks ?? readSpawnClockTicks;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.signalProcess = options.signalProcess ?? defaultSignalProcess;
    this.now = options.now ?? (() => new Date());
  }

  onCompletion(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => {
      this.completionListeners.delete(listener);
    };
  }

  isRunManagedInProcess(runId: string): boolean {
    return this.children.has(runId);
  }

  async spawn(spec: SpawnSpec): Promise<string> {
    await this.assertDirectoryExists(spec.cwd);
    this.checkPiAvailable();

    const runId = randomUUID();
    const runDir = this.getRunDir(runId);
    const brief = buildBrief(spec);
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = this.now();

    await mkdir(runDir, { recursive: true });
    await atomicWriteText(join(runDir, "brief.md"), brief);
    if (spec.model) {
      await atomicWriteJson(join(runDir, "settings.json"), { defaultModel: spec.model });
    }

    const stdoutHandle = await open(join(runDir, "stdout.log"), "a");
    const stderrHandle = await open(join(runDir, "stderr.log"), "a");

    let child: ChildProcess;
    let initialStatus: RunStatus | null = null;
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });
    this.statusReady.set(runId, readyPromise);

    try {
      child = this.spawnProcess("pi", ["--session-dir", runDir, brief], {
        cwd: spec.cwd,
        detached: true,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      });

      child.on("exit", (exitCode) => {
        void this.handleChildExit(runId, exitCode, initialStatus);
      });

      await waitForChildSpawn(child);

      if (typeof child.pid !== "number") {
        throw new Error("Sub-agent process did not expose a PID");
      }

      const spawnClockTicks = await this.readSpawnClockTicks(child.pid);
      initialStatus = {
        runId,
        role: spec.role,
        cwd: spec.cwd,
        routing: spec.routing,
        status: "running",
        pid: child.pid,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
        spawnClockTicks,
      };

      await this.writeStatus(initialStatus);
      resolveReady!();
      this.children.set(runId, child);
      child.unref();
      return runId;
    } catch (err) {
      resolveReady!(); // Unblock handleChildExit if it's waiting
      try {
        if (typeof child?.pid === "number") {
          this.signalProcess(child.pid, "SIGTERM");
        }
      } catch {}
      throw err;
    } finally {
      await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
    }
  }

  async status(runId: string): Promise<RunStatus | null> {
    const current = await this.readStatus(runId);
    if (!current) return null;
    if (current.status !== "running") return current;
    return this.refreshRunningStatus(current);
  }

  async list(): Promise<RunStatus[]> {
    return this.listRuns(true);
  }

  /** List runs without refreshing status (for watcher use). */
  async listRaw(): Promise<RunStatus[]> {
    return this.listRuns(false);
  }

  private async listRuns(refresh: boolean): Promise<RunStatus[]> {
    try {
      const entries = await readdir(this.subagentsRoot, { withFileTypes: true });
      const statuses = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => refresh ? this.status(entry.name) : this.readStatus(entry.name)),
      );
      return statuses.filter((status): status is RunStatus => status !== null);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async abort(runId: string): Promise<void> {
    await this.terminateRun(runId, "failed");
  }

  async enforceTimeout(runId: string): Promise<RunStatus | null> {
    const current = await this.readStatus(runId);
    if (!current || current.status !== "running") return current;
    return this.terminateRun(runId, "timeout");
  }

  /** Called by watcher to finalize dead out-of-process runs WITH notification. */
  async recoverRun(runId: string): Promise<RunStatus | null> {
    const current = await this.readStatus(runId);
    if (!current || current.status !== "running") return current;
    return this.refreshRunningStatus(current, true);
  }

  private async terminateRun(runId: string, outcome: TerminalStatus): Promise<RunStatus | null> {
    const current = await this.readStatus(runId);
    if (!current || current.status !== "running") return current;

    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (!alive) {
      return this.finalizeRun(runId, "failed", {});
    }

    this.pendingTerminalStatus.set(runId, outcome);
    try {
      this.signalProcess(current.pid, "SIGTERM");
    } catch {
      this.pendingTerminalStatus.delete(runId);
      return this.finalizeRun(runId, "failed", {});
    }

    return current;
  }

  private async refreshRunningStatus(current: RunStatus, notify = false): Promise<RunStatus> {
    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (alive) return current;

    // Process is dead. If called from status() (notify=false), finalize silently.
    // If called from watcher (notify=true), fire completion notification.
    const outcome = this.pendingTerminalStatus.get(current.runId) ?? "failed";
    return this.finalizeRun(current.runId, outcome, { notify });
  }

  private async handleChildExit(
    runId: string,
    exitCode: number | null,
    initialStatus: RunStatus | null,
  ): Promise<void> {
    // Wait for status.json to be written (handles fast-exit race)
    const ready = this.statusReady.get(runId);
    if (ready) {
      await ready;
      this.statusReady.delete(runId);
    }

    this.children.delete(runId);

    const current = await this.readStatus(runId) ?? initialStatus;
    if (!current || current.status !== "running") {
      this.pendingTerminalStatus.delete(runId);
      return;
    }

    const outcome = this.pendingTerminalStatus.get(runId)
      ?? (exitCode === 0 ? "complete" : "failed");

    await this.finalizeRun(runId, outcome, {
      exitCode: exitCode ?? undefined,
    });
  }

  private async finalizeRun(
    runId: string,
    status: TerminalStatus,
    extra: { exitCode?: number; notify?: boolean },
  ): Promise<RunStatus> {
    const current = await this.readStatus(runId);
    if (!current) {
      throw new Error(`Unknown sub-agent run: ${runId}`);
    }
    if (current.status !== "running") return current;

    const updated: RunStatus = {
      ...current,
      status,
      completedAt: this.now().toISOString(),
      exitCode: extra.exitCode ?? current.exitCode,
    };

    await this.writeStatus(updated);
    this.pendingTerminalStatus.delete(runId);
    if (extra.notify !== false) {
      await this.notifyCompletion(updated);
    }
    return updated;
  }

  private async notifyCompletion(status: RunStatus): Promise<void> {
    await Promise.allSettled(
      [...this.completionListeners].map((listener) => Promise.resolve(listener(status))),
    );
  }

  private async readStatus(runId: string): Promise<RunStatus | null> {
    try {
      const raw = await readFile(join(this.getRunDir(runId), "status.json"), "utf8");
      return JSON.parse(raw) as RunStatus;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeStatus(status: RunStatus): Promise<void> {
    await mkdir(this.getRunDir(status.runId), { recursive: true });
    await atomicWriteJson(join(this.getRunDir(status.runId), "status.json"), status);
  }

  private getRunDir(runId: string): string {
    return join(this.subagentsRoot, runId);
  }

  private async assertDirectoryExists(path: string): Promise<void> {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`Sub-agent cwd is not a directory: ${path}`);
    }
  }
}

function defaultPiAvailabilityCheck(): void {
  // Cached: only check once per process lifetime
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

function defaultSignalProcess(pid: number, signal: "SIGTERM"): void {
  process.kill(pid, signal);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
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

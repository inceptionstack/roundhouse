import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "./brief";
import { isProcessAlive as defaultIsProcessAlive } from "./pid";
import { ProcessLauncher, type ProcessLauncherOptions } from "./process-launcher";
import { RunFinalizer } from "./run-finalizer";
import { RunStore } from "./run-store";
import { TerminationHandler } from "./termination-handler";
import type { RunStatus, SpawnSpec, SubAgentLifecycle, SubAgentOrchestrator } from "./types";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const RUN_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Files the orchestrator and the sub-agent's own process write in the run folder. */
const RESERVED_RUN_FILES = new Set(["brief.md", "status.json", "settings.json", "stdout.log", "stderr.log"]);

export interface OrchestratorOptions extends ProcessLauncherOptions {
  dataRoot?: string;
  isProcessAlive?: (pid: number, expectedTicks: string) => Promise<boolean>;
  now?: () => Date;
}

export class SubAgentOrchestratorImpl implements SubAgentOrchestrator, SubAgentLifecycle {
  private readonly store: RunStore;
  private readonly launcher: ProcessLauncher;
  private readonly isProcessAlive: (pid: number, expectedTicks: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly finalizer: RunFinalizer;
  private readonly terminationHandler: TerminationHandler;
  private readonly children = new Map<string, { pid: number }>();
  private readonly statusReady = new Map<string, Promise<void>>();
  /** One timer per run this process started: the watcher leaves those to us (see isRunManagedInProcess). */
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: OrchestratorOptions = {}) {
    const dataRoot = options.dataRoot ?? join(homedir(), ".roundhouse");
    this.store = new RunStore(dataRoot);
    this.launcher = new ProcessLauncher(options);
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.now = options.now ?? (() => new Date());
    this.finalizer = new RunFinalizer({ store: this.store, now: this.now });
    this.terminationHandler = new TerminationHandler({
      store: this.store,
      isProcessAlive: this.isProcessAlive,
      signalProcess: this.launcher.signalProcess,
      finalizeRun: this.finalizer.finalizeRun.bind(this.finalizer),
    });
  }
  onCompletion(listener: (status: RunStatus) => Promise<void> | void): () => void { return this.finalizer.onCompletion(listener); }
  private spawnListeners: Array<(status: RunStatus) => Promise<void> | void> = [];
  onSpawn(listener: (status: RunStatus) => Promise<void> | void): () => void {
    this.spawnListeners.push(listener);
    return () => { this.spawnListeners = this.spawnListeners.filter(l => l !== listener); };
  }
  isRunManagedInProcess(runId: string): boolean { return this.children.has(runId); }

  async spawn(spec: SpawnSpec): Promise<string> {
    await assertDirectoryExists(spec.cwd);
    this.launcher.assertAvailable();

    const runId = randomUUID();
    const runDir = this.store.getRunDir(runId);
    const files = Object.entries(spec.files ?? {});
    for (const [name] of files) {
      if (!RUN_FILE_NAME_RE.test(name) || RESERVED_RUN_FILES.has(name.toLowerCase())) {
        throw new Error(`Invalid sub-agent file name: ${JSON.stringify(name)}`);
      }
    }
    const brief = buildBrief(files.length
      ? { ...spec, context: { ...spec.context, targetFiles: [...(spec.context?.targetFiles ?? []), ...files.map(([name]) => join(runDir, name))] } }
      : spec);
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = this.now();

    await mkdir(runDir, { recursive: true, mode: 0o700 });
    for (const [name, content] of files) await this.store.writeFile(runId, name, content);
    await this.store.writeFile(runId, "brief.md", brief);
    if (spec.model) {
      await this.store.writeJson(runId, "settings.json", { defaultModel: spec.model });
    }

    let resolveReady: () => void;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });
    this.statusReady.set(runId, readyPromise);
    let launchedChild: ChildProcess | undefined;
    let launchedPid: number | undefined;

    try {
      const { pid, spawnClockTicks } = await this.launcher.launch(runDir, spec.cwd, (child) => {
        launchedChild = child;
        child.on("exit", (exitCode) => {
          void this.handleChildExit(runId, exitCode);
        });
        if (child.exitCode !== null) {
          void this.handleChildExit(runId, child.exitCode);
        }
      }, spec.tools);
      launchedPid = pid;

      const initialStatus: RunStatus = {
        runId,
        role: spec.role,
        cwd: spec.cwd,
        routing: spec.routing,
        status: "running",
        ...(spec.delivery ? { delivery: spec.delivery } : {}),
        pid,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
        spawnClockTicks,
      };

      this.children.set(runId, { pid });
      await this.store.write(initialStatus);
      this.armDeadline(runId, timeoutMs);
      resolveReady!();

      // Notify spawn listeners
      for (const listener of this.spawnListeners) {
        try { await listener(initialStatus); } catch {}
      }

      return runId;
    } catch (err) {
      this.children.delete(runId);
      this.clearDeadline(runId);
      // Nothing was started: do not leave the folder, and what was written into it, behind.
      if (typeof launchedPid !== "number" && typeof launchedChild?.pid !== "number") {
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
      if (typeof launchedPid === "number") {
        // Defense in depth: the launcher handles /proc/bootstrap failures, while the orchestrator
        // still owns cleanup for later failures such as status.json persistence after launch.
        try {
          this.launcher.signalProcess(launchedPid, "SIGTERM");
        } catch {}
      } else if (typeof launchedChild?.pid === "number") {
        try {
          this.launcher.signalProcess(launchedChild.pid, "SIGTERM");
        } catch {}
      }
      resolveReady!();
      this.statusReady.delete(runId);
      throw err;
    }
  }

  async status(runId: string): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current) return null;
    if (current.status !== "running") return current;
    return this.refreshRunningStatus(current);
  }

  /**
   * The watcher skips runs this process started, so without a timer here a run
   * that hangs would never be cut off by the process that is waiting for it.
   */
  private armDeadline(runId: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(runId);
      void this.enforceTimeout(runId).catch((err) => console.error("[roundhouse] sub-agent timeout failed:", (err as Error).message));
    }, Math.min(timeoutMs, MAX_TIMER_MS)); // a longer delay would fire at once
    timer.unref?.();
    this.deadlines.set(runId, timer);
  }

  private clearDeadline(runId: string): void {
    const timer = this.deadlines.get(runId);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(runId);
  }

  async list(): Promise<RunStatus[]> { return this.listRuns(true); }
  async listRaw(): Promise<RunStatus[]> { return this.listRuns(false); }

  private async listRuns(refresh: boolean): Promise<RunStatus[]> {
    const dirs = await this.store.listDirs();
    const statuses = await Promise.all(
      dirs.map((id) => refresh ? this.status(id) : this.store.read(id)),
    );
    return statuses.filter((s): s is RunStatus => s !== null);
  }

  async abort(runId: string): Promise<void> { await this.terminationHandler.terminateRun(runId, "aborted"); }

  async enforceTimeout(runId: string): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    return this.terminationHandler.terminateRun(runId, "timeout");
  }

  async recoverRun(runId: string): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    return this.refreshRunningStatus(current, true);
  }

  private async refreshRunningStatus(current: RunStatus, notify = false): Promise<RunStatus> {
    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (alive) return current;

    // Process is dead. If it had a requested outcome (abort/timeout), use that.
    // Otherwise check stdout — orphan recovery doesn't know exit code.
    const outcome = current.requestedOutcome
      ? this.terminationHandler.terminalStatusFor(current)
      : await this.inferFromStdout(current.runId);
    return this.finalizer.finalizeRun(current.runId, outcome, { notify });
  }

  private async handleChildExit(runId: string, exitCode: number | null): Promise<void> {
    const ready = this.statusReady.get(runId);
    if (ready) {
      await ready;
      this.statusReady.delete(runId);
    }

    this.children.delete(runId);
    this.clearDeadline(runId);

    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return;

    const outcome = current.requestedOutcome
      ? this.terminationHandler.terminalStatusFor(current)
      : await this.inferOutcome(runId, exitCode);

    await this.finalizer.finalizeRun(runId, outcome, { exitCode: exitCode ?? undefined });
  }
  /**
   * Determine terminal status for a child exit.
   * If exit code is non-zero but the agent produced meaningful stdout output,
   * treat as "complete" — the work succeeded but the process had a teardown error
   * (e.g. pi-hard-no stale context exception on session close).
   */
  private async inferOutcome(runId: string, exitCode: number | null): Promise<"complete" | "failed"> {
    if (exitCode === 0) return "complete";
    if (exitCode === null) {
      // For handleChildExit: null means signal-killed → failed
      // But callers recovering orphans should use inferFromStdout directly
      return "failed";
    }
    return this.inferFromStdout(runId);
  }

  /**
   * Check stdout for substantial output. Used for:
   * - Non-zero exit codes (teardown errors)
   * - Recovered orphan processes (unknown exit code)
   */
  private async inferFromStdout(runId: string): Promise<"complete" | "failed"> {
    try {
      const stdoutPath = join(this.store.getRunDir(runId), "stdout.log");
      const content = await readFile(stdoutPath, "utf-8");
      if (content.trim().length > 50) return "complete";
    } catch {
      // No stdout file or can't read
    }
    return "failed";
  }
}

async function assertDirectoryExists(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Sub-agent cwd is not a directory: ${path}`);
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`Sub-agent cwd does not exist: ${path}`);
    throw err;
  }
}

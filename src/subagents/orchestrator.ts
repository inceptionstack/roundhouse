import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
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
  isRunManagedInProcess(runId: string): boolean { return this.children.has(runId); }

  async spawn(spec: SpawnSpec): Promise<string> {
    await assertDirectoryExists(spec.cwd);
    this.launcher.assertAvailable();

    const runId = randomUUID();
    const runDir = this.store.getRunDir(runId);
    const brief = buildBrief(spec);
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = this.now();

    await mkdir(runDir, { recursive: true });
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
      });
      launchedPid = pid;

      const initialStatus: RunStatus = {
        runId,
        role: spec.role,
        cwd: spec.cwd,
        routing: spec.routing,
        status: "running",
        pid,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
        spawnClockTicks,
      };

      this.children.set(runId, { pid });
      await this.store.write(initialStatus);
      resolveReady!();
      return runId;
    } catch (err) {
      this.children.delete(runId);
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

    const outcome = this.terminationHandler.terminalStatusFor(current);
    return this.finalizer.finalizeRun(current.runId, outcome, { notify });
  }

  private async handleChildExit(runId: string, exitCode: number | null): Promise<void> {
    const ready = this.statusReady.get(runId);
    if (ready) {
      await ready;
      this.statusReady.delete(runId);
    }

    this.children.delete(runId);

    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return;

    const outcome = current.requestedOutcome
      ? this.terminationHandler.terminalStatusFor(current)
      : (exitCode === 0 ? "complete" : "failed");

    await this.finalizer.finalizeRun(runId, outcome, { exitCode: exitCode ?? undefined });
  }
}

async function assertDirectoryExists(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`Sub-agent cwd is not a directory: ${path}`);
}

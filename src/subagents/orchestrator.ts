import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "./brief";
import { isProcessAlive as defaultIsProcessAlive } from "./pid";
import { ProcessLauncher, type ProcessLauncherOptions } from "./process-launcher";
import { RunStore } from "./run-store";
import type { RunStatus, SpawnSpec, SubAgentLifecycle, SubAgentOrchestrator } from "./types";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type TerminalStatus = Exclude<RunStatus["status"], "running">;
type RequestedOutcome = NonNullable<RunStatus["requestedOutcome"]>;
type CompletionListener = (status: RunStatus) => Promise<void> | void;
const TERMINATE_GRACE_MS = 10_000;

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
  private readonly children = new Map<string, { pid: number }>();
  private readonly completionListeners = new Set<CompletionListener>();
  private readonly statusReady = new Map<string, Promise<void>>();
  private readonly finalizingRuns = new Set<string>();

  constructor(options: OrchestratorOptions = {}) {
    const dataRoot = options.dataRoot ?? join(homedir(), ".roundhouse");
    this.store = new RunStore(dataRoot);
    this.launcher = new ProcessLauncher(options);
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.now = options.now ?? (() => new Date());
  }

  onCompletion(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  }

  isRunManagedInProcess(runId: string): boolean {
    return this.children.has(runId);
  }

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

  async list(): Promise<RunStatus[]> {
    return this.listRuns(true);
  }

  async listRaw(): Promise<RunStatus[]> {
    return this.listRuns(false);
  }

  private async listRuns(refresh: boolean): Promise<RunStatus[]> {
    const dirs = await this.store.listDirs();
    const statuses = await Promise.all(
      dirs.map((id) => refresh ? this.status(id) : this.store.read(id)),
    );
    return statuses.filter((s): s is RunStatus => s !== null);
  }

  async abort(runId: string): Promise<void> {
    await this.terminateRun(runId, "aborted");
  }

  async enforceTimeout(runId: string): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    return this.terminateRun(runId, "timeout");
  }

  async recoverRun(runId: string): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    return this.refreshRunningStatus(current, true);
  }

  // --- State machine ---

  private async terminateRun(runId: string, outcome: RequestedOutcome): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    const updated = await this.persistRequestedOutcome(current, outcome);

    const alive = await this.isProcessAlive(updated.pid, updated.spawnClockTicks);
    if (!alive) {
      return this.finalizeRun(runId, this.terminalStatusFor(updated), {});
    }

    try {
      this.launcher.signalProcess(updated.pid, "SIGTERM");
    } catch {
      return this.finalizeRun(runId, this.terminalStatusFor(updated), {});
    }

    setTimeout(() => {
      void this.escalateTermination(runId, updated.pid, updated.spawnClockTicks);
    }, TERMINATE_GRACE_MS);

    return updated;
  }

  private async refreshRunningStatus(current: RunStatus, notify = false): Promise<RunStatus> {
    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (alive) return current;

    const outcome = this.terminalStatusFor(current);
    return this.finalizeRun(current.runId, outcome, { notify });
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
      ? this.terminalStatusFor(current)
      : (exitCode === 0 ? "complete" : "failed");

    await this.finalizeRun(runId, outcome, { exitCode: exitCode ?? undefined });
  }

  private async finalizeRun(
    runId: string,
    status: TerminalStatus,
    extra: { exitCode?: number; notify?: boolean },
  ): Promise<RunStatus> {
    const current = await this.store.read(runId);
    if (!current) throw new Error(`Unknown sub-agent run: ${runId}`);
    if (current.status !== "running") return current;
    if (this.finalizingRuns.has(runId)) return current;

    this.finalizingRuns.add(runId);
    try {
      const latest = await this.store.read(runId);
      if (!latest) throw new Error(`Unknown sub-agent run: ${runId}`);
      if (latest.status !== "running") return latest;

      const updated: RunStatus = {
        ...latest,
        status,
        completedAt: this.now().toISOString(),
        exitCode: extra.exitCode ?? latest.exitCode,
      };

      await this.store.write(updated);
      if (extra.notify !== false) {
        await this.notifyCompletion(updated);
      }
      return updated;
    } finally {
      this.finalizingRuns.delete(runId);
    }
  }

  private async notifyCompletion(status: RunStatus): Promise<void> {
    await Promise.allSettled(
      [...this.completionListeners].map((l) => Promise.resolve(l(status))),
    );
  }

  private terminalStatusFor(status: RunStatus): TerminalStatus {
    if (status.requestedOutcome === "timeout") return "timeout";
    if (status.requestedOutcome === "aborted") return "failed";
    return "failed";
  }

  private async persistRequestedOutcome(current: RunStatus, requestedOutcome: RequestedOutcome): Promise<RunStatus> {
    if (current.requestedOutcome === requestedOutcome) return current;
    const updated: RunStatus = { ...current, requestedOutcome };
    await this.store.write(updated);
    return updated;
  }

  private async escalateTermination(runId: string, pid: number, spawnClockTicks: string): Promise<void> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return;
    if (current.pid !== pid || current.spawnClockTicks !== spawnClockTicks) return;

    const alive = await this.isProcessAlive(pid, spawnClockTicks);
    if (!alive) return;

    try {
      this.launcher.signalProcess(pid, "SIGKILL");
    } catch {}
  }
}

async function assertDirectoryExists(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`Sub-agent cwd is not a directory: ${path}`);
  }
}

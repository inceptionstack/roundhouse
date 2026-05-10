import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBrief } from "./brief";
import { isProcessAlive as defaultIsProcessAlive } from "./pid";
import { ProcessLauncher, type ProcessLauncherOptions } from "./process-launcher";
import { RunStore } from "./run-store";
import type { RunStatus, SpawnSpec, SubAgentLifecycle, SubAgentOrchestrator } from "./types";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

type TerminalStatus = Exclude<RunStatus["status"], "running">;
type CompletionListener = (status: RunStatus) => Promise<void> | void;

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
  private readonly pendingTerminalStatus = new Map<string, TerminalStatus>();
  private readonly completionListeners = new Set<CompletionListener>();
  private readonly statusReady = new Map<string, Promise<void>>();

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

    try {
      const { child, pid, spawnClockTicks } = await this.launcher.launch(runDir, brief, spec.cwd);

      child.on("exit", (exitCode) => {
        void this.handleChildExit(runId, exitCode);
      });

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

      await this.store.write(initialStatus);
      resolveReady!();
      this.children.set(runId, { pid });
      return runId;
    } catch (err) {
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
    await this.terminateRun(runId, "failed");
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

  private async terminateRun(runId: string, outcome: TerminalStatus): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;

    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (!alive) {
      return this.finalizeRun(runId, outcome, {});
    }

    this.pendingTerminalStatus.set(runId, outcome);
    try {
      this.launcher.signalProcess(current.pid, "SIGTERM");
    } catch {
      this.pendingTerminalStatus.delete(runId);
      return this.finalizeRun(runId, "failed", {});
    }

    return current;
  }

  private async refreshRunningStatus(current: RunStatus, notify = false): Promise<RunStatus> {
    const alive = await this.isProcessAlive(current.pid, current.spawnClockTicks);
    if (alive) return current;

    const outcome = this.pendingTerminalStatus.get(current.runId) ?? "failed";
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
    if (!current || current.status !== "running") {
      this.pendingTerminalStatus.delete(runId);
      return;
    }

    const outcome = this.pendingTerminalStatus.get(runId)
      ?? (exitCode === 0 ? "complete" : "failed");

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

    const updated: RunStatus = {
      ...current,
      status,
      completedAt: this.now().toISOString(),
      exitCode: extra.exitCode ?? current.exitCode,
    };

    await this.store.write(updated);
    this.pendingTerminalStatus.delete(runId);
    if (extra.notify !== false) {
      await this.notifyCompletion(updated);
    }
    return updated;
  }

  private async notifyCompletion(status: RunStatus): Promise<void> {
    await Promise.allSettled(
      [...this.completionListeners].map((l) => Promise.resolve(l(status))),
    );
  }
}

async function assertDirectoryExists(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`Sub-agent cwd is not a directory: ${path}`);
  }
}

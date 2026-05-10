import type { RunStatus, TerminalStatus } from "./types";
import { RunStore } from "./run-store";

const TERMINATE_GRACE_MS = 10_000;

type RequestedOutcome = NonNullable<RunStatus["requestedOutcome"]>;

export interface TerminationHandlerOptions {
  store: RunStore;
  isProcessAlive: (pid: number, expectedTicks: string) => Promise<boolean>;
  signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  finalizeRun: (
    runId: string,
    status: TerminalStatus,
    extra: { exitCode?: number; notify?: boolean },
  ) => Promise<RunStatus>;
}

export class TerminationHandler {
  private readonly store: RunStore;
  private readonly isProcessAlive: (pid: number, expectedTicks: string) => Promise<boolean>;
  private readonly signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  private readonly finalizeRun: (
    runId: string,
    status: TerminalStatus,
    extra: { exitCode?: number; notify?: boolean },
  ) => Promise<RunStatus>;

  constructor(options: TerminationHandlerOptions) {
    this.store = options.store;
    this.isProcessAlive = options.isProcessAlive;
    this.signalProcess = options.signalProcess;
    this.finalizeRun = options.finalizeRun;
  }

  async terminateRun(runId: string, outcome: RequestedOutcome): Promise<RunStatus | null> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return current;
    const updated = await this.persistRequestedOutcome(current, outcome);

    const alive = await this.isProcessAlive(updated.pid, updated.spawnClockTicks);
    if (!alive) {
      return this.finalizeRun(runId, this.terminalStatusFor(updated), {});
    }

    try {
      this.signalProcess(updated.pid, "SIGTERM");
    } catch {
      return this.finalizeRun(runId, this.terminalStatusFor(updated), {});
    }

    setTimeout(() => {
      void this.escalateTermination(runId, updated.pid, updated.spawnClockTicks);
    }, TERMINATE_GRACE_MS);

    return updated;
  }

  async escalateTermination(runId: string, pid: number, spawnClockTicks: string): Promise<void> {
    const current = await this.store.read(runId);
    if (!current || current.status !== "running") return;
    if (current.pid !== pid || current.spawnClockTicks !== spawnClockTicks) return;

    const alive = await this.isProcessAlive(pid, spawnClockTicks);
    if (!alive) return;

    try {
      this.signalProcess(pid, "SIGKILL");
    } catch {}
  }

  terminalStatusFor(status: RunStatus): TerminalStatus {
    if (status.requestedOutcome === "timeout") return "timeout";
    // "aborted" maps to "failed" because there's no "aborted" terminal status in the
    // RunStatus union — abort is an intent, "failed" is the observable outcome.
    if (status.requestedOutcome === "aborted") return "failed";
    return "failed";
  }

  async persistRequestedOutcome(current: RunStatus, requestedOutcome: RequestedOutcome): Promise<RunStatus> {
    if (current.requestedOutcome === requestedOutcome) return current;
    const updated: RunStatus = { ...current, requestedOutcome };
    await this.store.write(updated);
    return updated;
  }
}


import { RunStore } from "./run-store";
import type { RunStatus } from "./types";

type TerminalStatus = Exclude<RunStatus["status"], "running">;
type CompletionListener = (status: RunStatus) => Promise<void> | void;

export interface RunFinalizerOptions {
  store: RunStore;
  now: () => Date;
}

export class RunFinalizer {
  private readonly store: RunStore;
  private readonly now: () => Date;
  private readonly completionListeners = new Set<CompletionListener>();
  private readonly finalizingRuns = new Map<string, Promise<RunStatus>>();

  constructor(options: RunFinalizerOptions) {
    this.store = options.store;
    this.now = options.now;
  }

  onCompletion(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  }

  async finalizeRun(
    runId: string,
    status: TerminalStatus,
    extra: { exitCode?: number; notify?: boolean },
  ): Promise<RunStatus> {
    const inFlight = this.finalizingRuns.get(runId);
    if (inFlight) return inFlight;

    const finalization = (async (): Promise<RunStatus> => {
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
        await Promise.allSettled(
          [...this.completionListeners].map((listener) => Promise.resolve(listener(updated))),
        );
      }
      return updated;
    })();

    this.finalizingRuns.set(runId, finalization);
    try {
      return await finalization;
    } finally {
      this.finalizingRuns.delete(runId);
    }
  }
}


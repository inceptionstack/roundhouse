import { SubAgentOrchestratorImpl } from "./orchestrator";
import type { RoutingInfo, RunStatus } from "./types";

export class SubAgentWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private polling = false;

  constructor(
    private readonly orchestrator: SubAgentOrchestratorImpl,
    private readonly notifyCompletion: (status: RunStatus, routing: RoutingInfo) => Promise<void> | void,
    private readonly pollIntervalMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;

    this.unsubscribe = this.orchestrator.onCompletion((status) =>
      this.notifyCompletion(status, status.routing),
    );

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const statuses = await this.orchestrator.list();
      const now = Date.now();

      for (const status of statuses) {
        if (status.status !== "running") continue;
        if (this.orchestrator.isRunManagedInProcess(status.runId)) continue;

        if (status.deadlineAt && Date.parse(status.deadlineAt) <= now) {
          await this.orchestrator.enforceTimeout(status.runId);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

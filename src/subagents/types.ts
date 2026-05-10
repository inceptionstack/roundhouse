export type SubAgentRole = "review" | "research" | "scout" | "implementation";

/** Terminal states for a sub-agent run (excludes "running") */
export type TerminalStatus = Exclude<RunStatus["status"], "running">;

export interface RoutingInfo {
  transport: "telegram";
  chatId: string;
  topicId?: string;
  parentThreadId: string;
}

export interface SpawnSpec {
  role: SubAgentRole;
  task: string;
  cwd: string;
  routing: RoutingInfo;
  context?: {
    briefing?: string;
    targetFiles?: string[];
    completionContract?: string;
  };
  model?: string;
  timeoutMs?: number;
}

export interface RunStatus {
  runId: string;
  role: SubAgentRole;
  cwd: string;
  routing: RoutingInfo;
  status: "running" | "complete" | "failed" | "timeout";
  requestedOutcome?: "aborted" | "timeout";
  pid: number;
  startedAt: string;
  deadlineAt?: string;
  completedAt?: string;
  exitCode?: number;
  spawnClockTicks: string;
}

/** Public API for consumers (gateway, commands, agent tools) */
export interface SubAgentOrchestrator {
  spawn(spec: SpawnSpec): Promise<string>;
  status(runId: string): Promise<RunStatus | null>;
  list(): Promise<RunStatus[]>;
  abort(runId: string): Promise<void>;
}

/** Internal API used by SubAgentWatcher for lifecycle management */
export interface SubAgentLifecycle {
  listRaw(): Promise<RunStatus[]>;
  recoverRun(runId: string): Promise<RunStatus | null>;
  enforceTimeout(runId: string): Promise<RunStatus | null>;
  isRunManagedInProcess(runId: string): boolean;
  onCompletion(listener: (status: RunStatus) => Promise<void> | void): () => void;
}

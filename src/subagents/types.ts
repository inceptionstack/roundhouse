export type SubAgentRole = "review" | "research" | "scout" | "implementation";

/** Terminal states for a sub-agent run (excludes "running") */
export type TerminalStatus = Exclude<RunStatus["status"], "running">;

export interface RoutingInfo {
  transport: "telegram" | "slack";
  chatId: string;
  topicId?: string;
  parentThreadId: string;
}

/**
 * Where a finished run's output goes.
 *  - "agent" (default): the owner is told it finished, and the output is handed
 *    to the agent as a new turn, which then reports on it.
 *  - "chat": the output is posted to the owner as it is, and no agent turn
 *    starts. For a report the owner asked to read himself, such as the review
 *    after /stop, where an agent that starts working again is the last thing wanted.
 */
export type SubAgentDelivery = "agent" | "chat";

export interface SpawnSpec {
  role: SubAgentRole;
  task: string;
  cwd: string;
  routing: RoutingInfo;
  /**
   * Tools the sub-agent may use (pi's `--tools`, plain names), e.g.
   * ["read", "grep", "find", "ls"] for a reader that cannot change anything.
   * Without it the sub-agent has pi's defaults, which include a shell.
   * A list also switches MCP off for that run.
   */
  tools?: string[];
  delivery?: SubAgentDelivery;
  /**
   * Text files to put in the run's own folder before it starts, by file name
   * (letters, digits, `.`, `_`, `-`). Each is added to the brief's Target Files
   * with its full path, so a large input is read by the sub-agent instead of
   * being pasted into its prompt.
   */
  files?: Record<string, string>;
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
  delivery?: SubAgentDelivery;
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
  onSpawn(listener: (status: RunStatus) => Promise<void> | void): () => void;
}

/** Internal API used by SubAgentWatcher for lifecycle management */
export interface SubAgentLifecycle {
  listRaw(): Promise<RunStatus[]>;
  recoverRun(runId: string): Promise<RunStatus | null>;
  enforceTimeout(runId: string): Promise<RunStatus | null>;
  isRunManagedInProcess(runId: string): boolean;
  onCompletion(listener: (status: RunStatus) => Promise<void> | void): () => void;
}

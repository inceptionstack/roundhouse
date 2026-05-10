export type SubAgentRole = "review" | "research" | "scout" | "implementation";

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
  pid: number;
  startedAt: string;
  deadlineAt?: string;
  completedAt?: string;
  exitCode?: number;
  spawnClockTicks: string;
}

export interface SubAgentOrchestrator {
  spawn(spec: SpawnSpec): Promise<string>;
  status(runId: string): Promise<RunStatus | null>;
  list(): Promise<RunStatus[]>;
  abort(runId: string): Promise<void>;
}

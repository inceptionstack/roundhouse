/**
 * memory/types.ts — Memory system types
 */

/** Memory operating mode */
export type MemoryMode = "full" | "complement" | "unknown";

/** Memory configuration (in gateway.config.json) */
export interface MemoryConfig {
  /** Enable memory system (default: true) */
  enabled?: boolean;
  /** Root directory for memory files (default: agent cwd) */
  rootDir?: string;
  /** Main durable memory file (default: "MEMORY.md") */
  mainFile?: string;
  /** Daily notes directory (default: "daily") */
  dailyDir?: string;
  /** Injection settings */
  inject?: {
    /** Include today's daily note (default: true) */
    includeToday?: boolean;
    /** Number of recent days to include (default: 1 = yesterday) */
    includeRecentDays?: number;
    /** Max bytes to inject (default: 48000) */
    maxBytes?: number;
  };
  /** Compaction settings (active in BOTH modes) */
  compact?: {
    /** Enable proactive compaction (default: true) */
    enabled?: boolean;
    /** Soft flush threshold: percent of context (default: 0.45) */
    softPercent?: number;
    /** Soft flush threshold: absolute tokens (default: 180000) */
    softTokens?: number;
    /** Hard compact threshold: percent (default: 0.50) */
    hardPercent?: number;
    /** Hard compact threshold: absolute tokens (default: 200000) */
    hardTokens?: number;
    /** Emergency: compact when remaining tokens < this (default: 32768) */
    emergencyThresholdTokens?: number;
    /** Min time between soft flushes in ms (default: 600000 = 10min) */
    cooldownMs?: number;
  };
}

/** Per-thread memory tracking state */
export interface ThreadMemoryState {
  /** Hash of memory files when last injected into this thread */
  lastInjectedDigest?: string;
  /** Hash of memory files after last agent turn (may differ if agent wrote memory) */
  lastKnownDigest?: string;
  /** When memory was last injected */
  lastInjectedAt?: string;
  /** Local date when memory was last injected (detects day boundary) */
  lastSeenLocalDate?: string;
  /** Force re-injection on next turn */
  forceInjectReason?: "new-session" | "after-compact" | "manual";
  /** When last compaction happened */
  lastCompactAt?: string;
  /** Pending compaction level (from interrupted flush) */
  pendingCompact?: "soft" | "hard" | "emergency";
  /** When last soft flush happened (for cooldown) */
  lastSoftFlushAt?: string;
}

/** Resolved memory file set to inject */
export interface MemoryFileSet {
  files: Array<{ label: string; path: string }>;
}

/** Snapshot of memory file contents */
export interface MemorySnapshot {
  entries: Array<{ label: string; content: string }>;
  digest: string;
}

/** Context pressure classification */
export type PressureLevel = "none" | "soft" | "hard" | "emergency";

/** Result of preparing memory for a turn */
export interface PreparedTurn {
  /** Message to send (may have memory prepended) */
  message: import("../types").AgentMessage;
  /** Digest before the turn (for finalize) */
  beforeDigest: string | null;
  /** Whether memory was injected */
  injected: boolean;
  /** Pending compact level from a previously interrupted flush */
  pendingCompact?: "soft" | "hard" | "emergency";
}

/**
 * acp/process.ts — kiro-cli process lifecycle management
 *
 * Handles spawning, stderr capture, orphan guards, and graceful shutdown.
 * One process per agent config (main or flush).
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AcpClient } from "./client.js";

export interface SpawnOptions {
  agentName: string;
  cwd: string;
  env?: Record<string, string>;
  /** Max stderr buffer in bytes (default 1MB) */
  maxStderrBytes?: number;
}

export interface AcpProcess {
  client: AcpClient;
  proc: ChildProcessWithoutNullStreams;
  stderr: string[];
  kill(signal?: NodeJS.Signals): void;
  killGroup(): void;
}

/**
 * Spawn kiro-cli in ACP mode and return the wrapped process + client.
 * Throws if the binary is not found.
 */
export function spawnKiroCli(opts: SpawnOptions): AcpProcess {
  const { agentName, cwd, env, maxStderrBytes = 1_048_576 } = opts;

  const proc = spawn("kiro-cli", ["acp", "--agent", agentName], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // own process group for clean kill
  });

  // Handle spawn failures (e.g. ENOENT if kiro-cli not on PATH)
  proc.on("error", (err) => {
    console.error(`[kiro] failed to spawn kiro-cli: ${err.message}`);
    // Emit exit so AcpClient rejects pending requests immediately
    proc.emit("exit", 1);
  });

  // Buffer stderr for diagnostics (capped)
  const stderr: string[] = [];
  let stderrBytes = 0;
  proc.stderr.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf8");
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderrBytes) {
      stderr.push(str);
    }
  });

  const client = new AcpClient(proc);

  return {
    client,
    proc,
    stderr,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try { proc.kill(signal); } catch {}
    },
    killGroup() {
      if (proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      }
    },
  };
}

/**
 * Gracefully shutdown a kiro-cli process:
 * SIGTERM → wait up to `gracePeriodMs` → SIGKILL the process group.
 */
export async function shutdownProcess(acpProc: AcpProcess, gracePeriodMs = 5_000): Promise<void> {
  acpProc.client.close();
  acpProc.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      acpProc.killGroup();
      resolve();
    }, gracePeriodMs);

    acpProc.proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Check if kiro-cli is available on PATH.
 * Returns the version string or null if not found.
 */
export function getKiroCliVersion(): string | null {
  try {
    const output = execFileSync("kiro-cli", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

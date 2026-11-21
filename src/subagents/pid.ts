import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface ParsedStatFile {
  state: string;
  starttime: string;
  isZombie: boolean;
}

export function parseStatFile(content: string): ParsedStatFile {
  const trimmed = content.trim();
  // Field 2 (comm) is parenthesized and can contain spaces/parens.
  // Strip everything through the LAST ") " to safely reach field 3+.
  const boundary = trimmed.lastIndexOf(") ");
  if (boundary === -1) {
    throw new Error("Invalid /proc stat format");
  }

  // After stripping pid + comm, remainder starts at field 3.
  // fields[0] = state (field 3), fields[19] = starttime (field 22).
  const remainder = trimmed.slice(boundary + 2).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length < 20) {
    throw new Error("Incomplete /proc stat format");
  }

  const state = fields[0];
  const starttime = fields[19]; // Original /proc field 22 (starttime)
  if (!state || !starttime) {
    throw new Error("Missing required /proc stat fields");
  }

  return {
    state,
    starttime,
    isZombie: state === "Z",
  };
}

/**
 * `/proc` exists on Linux only. Elsewhere (macOS, BSD) ask `ps` for the
 * process state and start time; the start time plays the role of the
 * starttime ticks: it tells a recycled pid from the process we spawned.
 */
const HAS_PROC = process.platform === "linux";

function psField(pid: number, field: "lstart" | "stat"): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", `${field}=`, "-p", String(pid)], { timeout: 5_000 }, (err, stdout) => {
      const value = String(stdout ?? "").trim();
      if (err || !value) return reject(err ?? new Error(`ps: no process ${pid}`));
      resolve(value);
    });
  });
}

export async function readSpawnClockTicks(pid: number): Promise<string> {
  if (!HAS_PROC) return psField(pid, "lstart");
  const content = await readFile(`/proc/${pid}/stat`, "utf8");
  return parseStatFile(content).starttime;
}

export async function isProcessAlive(pid: number, expectedTicks: string): Promise<boolean> {
  try {
    if (!HAS_PROC) {
      const [started, state] = await Promise.all([psField(pid, "lstart"), psField(pid, "stat")]);
      return !state.startsWith("Z") && started === expectedTicks;
    }
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    const parsed = parseStatFile(content);
    return !parsed.isZombie && parsed.starttime === expectedTicks;
  } catch {
    return false;
  }
}

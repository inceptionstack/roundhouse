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

export async function readSpawnClockTicks(pid: number): Promise<string> {
  const content = await readFile(`/proc/${pid}/stat`, "utf8");
  return parseStatFile(content).starttime;
}

export async function isProcessAlive(pid: number, expectedTicks: string): Promise<boolean> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    const parsed = parseStatFile(content);
    return !parsed.isZombie && parsed.starttime === expectedTicks;
  } catch {
    return false;
  }
}

import { readFile } from "node:fs/promises";

export interface ParsedStatFile {
  state: string;
  starttime: string;
  isZombie: boolean;
}

export function parseStatFile(content: string): ParsedStatFile {
  const trimmed = content.trim();
  const boundary = trimmed.lastIndexOf(") ");
  if (boundary === -1) {
    throw new Error("Invalid /proc stat format");
  }

  const remainder = trimmed.slice(boundary + 2).trim();
  const fields = remainder.split(/\s+/);
  if (fields.length < 20) {
    throw new Error("Incomplete /proc stat format");
  }

  const state = fields[0];
  const starttime = fields[19];
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

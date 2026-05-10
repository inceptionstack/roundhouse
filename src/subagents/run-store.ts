import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus } from "./types";

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid sub-agent run ID: ${runId}`);
  }
  return runId;
}

export class RunStore {
  private readonly subagentsRoot: string;

  constructor(dataRoot: string) {
    this.subagentsRoot = join(dataRoot, "subagents");
  }

  getRunDir(runId: string): string {
    return join(this.subagentsRoot, validateRunId(runId));
  }

  async read(runId: string): Promise<RunStatus | null> {
    try {
      const raw = await readFile(join(this.getRunDir(runId), "status.json"), "utf8");
      return JSON.parse(raw) as RunStatus;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(status: RunStatus): Promise<void> {
    const dir = this.getRunDir(status.runId);
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(join(dir, "status.json"), status);
  }

  async listDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.subagentsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
        .map((e) => e.name);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async writeFile(runId: string, filename: string, content: string): Promise<void> {
    const dir = this.getRunDir(runId);
    await mkdir(dir, { recursive: true });
    await atomicWriteText(join(dir, filename), content);
  }

  async writeJson(runId: string, filename: string, value: unknown): Promise<void> {
    const dir = this.getRunDir(runId);
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(join(dir, filename), value);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrief } from "../src/subagents/brief";
import { SubAgentOrchestratorImpl } from "../src/subagents/orchestrator";
import { parseStatFile } from "../src/subagents/pid";
import type { RunStatus, SpawnSpec } from "../src/subagents/types";

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/usr/bin/pi\n"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  };
});

describe("subagents", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `roundhouse-subagents-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(rootDir, { recursive: true });
    vi.clearAllMocks();
    execFileSyncMock.mockReturnValue("/usr/bin/pi\n");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("builds a delegation brief from spawn spec", () => {
    const brief = buildBrief({
      role: "implementation",
      task: "Implement the worker loop",
      cwd: "/workspace/project",
      routing: {
        transport: "telegram",
        chatId: "1",
        parentThreadId: "telegram:1:main",
      },
      context: {
        briefing: "Use the current gateway conventions.",
        targetFiles: ["src/subagents/orchestrator.ts", "src/subagents/watcher.ts"],
        completionContract: "Tests pass and status persistence is implemented.",
      },
    });

    expect(brief).toContain("# Role\nimplementation");
    expect(brief).toContain("# Task\nImplement the worker loop");
    expect(brief).toContain("# Working Directory\n/workspace/project");
    expect(brief).toContain("# Context\nUse the current gateway conventions.");
    expect(brief).toContain("- src/subagents/orchestrator.ts");
    expect(brief).toContain("# Done When\nTests pass and status persistence is implemented.");
  });

  it("parses /proc stat content with spaces, parentheses, and zombie state", () => {
    const running = parseStatFile(
      "4321 (pi worker (review)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242 20 21 22",
    );
    const zombie = parseStatFile(
      "4322 (pi worker (zombie)) Z 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 9999 20 21 22",
    );

    expect(running.state).toBe("S");
    expect(running.starttime).toBe("4242");
    expect(running.isZombie).toBe(false);
    expect(zombie.isZombie).toBe(true);
  });

  it("spawns a detached pi process and persists run state", async () => {
    const child = createMockChild(4321);
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const orchestrator = new SubAgentOrchestratorImpl({
      dataRoot: rootDir,
      readSpawnClockTicks: async () => "4242",
    });

    const spec: SpawnSpec = {
      role: "implementation",
      task: "Implement the orchestrator",
      cwd: rootDir,
      routing: {
        transport: "telegram",
        chatId: "123",
        topicId: "456",
        parentThreadId: "telegram:123:456:789",
      },
      model: "gpt-5.4",
      timeoutMs: 30_000,
    };

    const runId = await orchestrator.spawn(spec);
    const runDir = join(rootDir, "subagents", runId);
    const status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunStatus;
    const settings = JSON.parse(await readFile(join(runDir, "settings.json"), "utf8")) as Record<string, string>;
    const brief = await readFile(join(runDir, "brief.md"), "utf8");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("pi");
    expect(spawnMock.mock.calls[0]?.[1]?.[0]).toBe("--session-dir");
    expect(spawnMock.mock.calls[0]?.[1]?.[1]).toBe(runDir);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", expect.any(Number), expect.any(Number)],
    });
    expect(status.pid).toBe(4321);
    expect(status.spawnClockTicks).toBe("4242");
    expect(status.status).toBe("running");
    expect(settings.defaultModel).toBe("gpt-5.4");
    expect(brief).toContain("# Task\nImplement the orchestrator");
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("refreshes stale running status entries to failed", async () => {
    const runId = "run-refresh";
    await writeStatusFixture(rootDir, runId, {
      runId,
      role: "research",
      cwd: rootDir,
      routing: {
        transport: "telegram",
        chatId: "10",
        parentThreadId: "telegram:10:main",
      },
      status: "running",
      pid: 77,
      startedAt: "2026-05-10T12:00:00.000Z",
      deadlineAt: "2026-05-10T12:15:00.000Z",
      spawnClockTicks: "555",
    });

    const orchestrator = new SubAgentOrchestratorImpl({
      dataRoot: rootDir,
      isProcessAlive: async () => false,
    });

    const refreshed = await orchestrator.status(runId);

    expect(refreshed?.status).toBe("failed");
    expect(refreshed?.completedAt).toBeTruthy();
  });

  it("does not signal when abort sees a stale PID", async () => {
    const runId = "run-abort";
    const signalProcess = vi.fn();

    await writeStatusFixture(rootDir, runId, {
      runId,
      role: "review",
      cwd: rootDir,
      routing: {
        transport: "telegram",
        chatId: "20",
        parentThreadId: "telegram:20:main",
      },
      status: "running",
      pid: 88,
      startedAt: "2026-05-10T12:00:00.000Z",
      deadlineAt: "2026-05-10T12:15:00.000Z",
      spawnClockTicks: "777",
    });

    const orchestrator = new SubAgentOrchestratorImpl({
      dataRoot: rootDir,
      isProcessAlive: async () => false,
      signalProcess,
    });

    await orchestrator.abort(runId);

    const status = await orchestrator.status(runId);
    expect(signalProcess).not.toHaveBeenCalled();
    expect(status?.status).toBe("failed");
    expect(status?.completedAt).toBeTruthy();
  });
});

function createMockChild(pid: number): EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

async function writeStatusFixture(rootDir: string, runId: string, status: RunStatus): Promise<void> {
  const runDir = join(rootDir, "subagents", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "status.json"), JSON.stringify(status, null, 2) + "\n");
}

/**
 * cli/subagent-command.ts — CLI interface for sub-agent delegation
 *
 * Thin disk-state client that reads/writes ~/.roundhouse/subagents/ directly.
 * The gateway's watcher handles lifecycle (timeout, completion notification).
 * spawn() creates the process and persists state; the gateway adopts it on next poll.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SubAgentOrchestratorImpl } from "../subagents/orchestrator";
import type { SpawnSpec, SubAgentRole, RoutingInfo } from "../subagents/types";

const ROUNDHOUSE_DIR = join(homedir(), ".roundhouse");

function loadGatewayConfig(): { notifyChatIds: number[] } {
  try {
    const raw = readFileSync(join(ROUNDHOUSE_DIR, "gateway.config.json"), "utf8");
    const cfg = JSON.parse(raw);
    return { notifyChatIds: cfg?.chat?.notifyChatIds ?? [] };
  } catch {
    return { notifyChatIds: [] };
  }
}

function buildRouting(): RoutingInfo {
  const cfg = loadGatewayConfig();
  const chatId = String(cfg.notifyChatIds[0] ?? "");
  if (!chatId) {
    console.error("Error: no Telegram chat configured. Run 'roundhouse setup' first or pass --chat-id.");
    process.exit(1);
  }
  return {
    transport: "telegram",
    chatId,
    parentThreadId: `telegram:${chatId}:main`,
  };
}

export async function handleSubagentCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  const orchestrator = new SubAgentOrchestratorImpl();

  switch (subcommand) {
    case "spawn": {
      const role = getFlag(args, "--role") as SubAgentRole | undefined;
      const task = getFlag(args, "--task");
      const cwd = getFlag(args, "--cwd") || process.cwd();
      const model = getFlag(args, "--model");
      const timeoutStr = getFlag(args, "--timeout");

      if (!role || !task) {
        console.error("Usage: roundhouse subagent spawn --role <role> --task \"...\" [--cwd <dir>] [--model <id>] [--timeout <ms>]");
        process.exit(1);
      }

      const validRoles: SubAgentRole[] = ["review", "research", "scout", "implementation"];
      if (!validRoles.includes(role)) {
        console.error(`Invalid role: ${role}. Must be one of: ${validRoles.join(", ")}`);
        process.exit(1);
      }

      let timeoutMs: number | undefined;
      if (timeoutStr) {
        const n = Number(timeoutStr);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`Invalid timeout: ${timeoutStr}. Must be a positive number (milliseconds).`);
          process.exit(1);
        }
        timeoutMs = n;
      }

      const spec: SpawnSpec = {
        role,
        task,
        cwd,
        routing: buildRouting(),
        model: model || undefined,
        timeoutMs,
      };

      try {
        const runId = await orchestrator.spawn(spec);
        console.log(JSON.stringify({ runId, status: "spawned", role, cwd }));
      } catch (err) {
        console.error(`Spawn failed: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const runId = args[1];
      if (!runId) {
        console.error("Usage: roundhouse subagent status <runId>");
        process.exit(1);
      }
      const status = await orchestrator.status(runId);
      if (!status) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "list": {
      const statuses = await orchestrator.list();
      if (statuses.length === 0) {
        console.log("No sub-agent runs.");
      } else {
        for (const s of statuses) {
          const duration = s.completedAt
            ? `${Math.round((Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 1000)}s`
            : "running";
          console.log(`${s.status.padEnd(8)} ${s.role.padEnd(14)} ${duration.padEnd(8)} ${s.runId.slice(0, 8)}`);
        }
      }
      break;
    }

    case "abort": {
      const runId = args[1];
      if (!runId) {
        console.error("Usage: roundhouse subagent abort <runId>");
        process.exit(1);
      }
      // Sends SIGTERM to child PID. Gateway watcher finalizes status on next poll.
      await orchestrator.abort(runId);
      console.log(`Signal sent. Run ${runId.slice(0, 8)} will be finalized by gateway watcher.`);
      break;
    }

    default:
      console.error("Usage: roundhouse subagent <spawn|status|list|abort>");
      process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

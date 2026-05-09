/**
 * gateway/helpers.ts — Pure utility functions for the gateway
 *
 * Thread routing, command matching, system resources.
 * No side effects, no I/O — easily unit-testable.
 */

import { hostname, loadavg, totalmem, freemem, cpus } from "node:os";

// ── Command Matching ─────────────────────────────────

/**
 * Match a bot command, handling optional @botname suffix.
 */
export function isCommand(text: string, cmd: string, botUsername: string): boolean {
  if (text === cmd) return true;
  if (!text.startsWith(`${cmd}@`)) return false;
  if (!botUsername) return false;
  const suffix = text.slice(cmd.length + 1).toLowerCase();
  return suffix === botUsername.toLowerCase();
}

/**
 * Match a command that accepts subcommands (e.g. /crons trigger <id>).
 */
export function isCommandWithArgs(text: string, cmd: string, botUsername: string): boolean {
  if (text === cmd || text.startsWith(`${cmd} `)) return true;
  if (!text.startsWith(`${cmd}@`)) return false;
  if (!botUsername) return false;
  const rest = text.slice(cmd.length + 1);
  const spaceIdx = rest.indexOf(" ");
  const suffix = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  return suffix.toLowerCase() === botUsername.toLowerCase();
}

// ── Thread Routing ───────────────────────────────────

function telegramChatIdFromThreadId(threadId: unknown): number | null {
  if (typeof threadId !== "string") return null;
  const match = threadId.match(/^telegram:(-?\d+)/);
  if (!match) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getChatId(thread: any, message: any): string {
  const id = message?.chat?.id ?? message?.chatId ?? thread?.chatId;
  if (id !== undefined && id !== null) return String(id);
  return String(thread?.id ?? "unknown");
}

/**
 * Resolve the agent-facing thread ID from a chat message.
 * Private/DM → "main", group → "group:<chatId>"
 */
export function resolveAgentThreadId(thread: any, message: any): string {
  const chatType = String(message?.chat?.type ?? thread?.chat?.type ?? thread?.type ?? "").toLowerCase();
  if (["private", "dm", "direct", "im"].includes(chatType)) return "main";
  if (["group", "supergroup", "channel"].includes(chatType)) return `group:${getChatId(thread, message)}`;

  const telegramChatId = telegramChatIdFromThreadId(thread?.id);
  if (telegramChatId !== null) {
    return telegramChatId < 0 ? `group:${telegramChatId}` : "main";
  }

  return String(thread?.id ?? "main");
}

// ── System Resources ─────────────────────────────────

export interface SystemResources {
  load1: number;
  cpuCount: number;
  totalGB: string;
  usedGB: string;
  memPct: number;
  cpuPct: number;
}

export function getSystemResources(): SystemResources {
  const load1 = loadavg()[0];
  const cpuCount = cpus().length;
  const totalGB = (totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const usedGB = ((totalmem() - freemem()) / 1024 / 1024 / 1024).toFixed(1);
  const memPct = Math.round(((totalmem() - freemem()) / totalmem()) * 100);
  const cpuPct = Math.min(100, Math.round((load1 / cpuCount) * 100));
  return { load1, cpuCount, totalGB, usedGB, memPct, cpuPct };
}

// ── Tool Icons ───────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  bash: "⚡",
  read: "📖",
  edit: "✏️",
  write: "📝",
  grep: "🔍",
  find: "🔎",
  ls: "📂",
};

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "🔧";
}

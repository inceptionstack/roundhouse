/**
 * cli/agent-command.ts — `roundhouse agent` implementation
 *
 * Extracted from cli.ts for single responsibility.
 * Each sub-concern is a small, testable function.
 */

import { loadConfig } from "../config";
import type { AgentAdapter } from "../types";

// ── Types ────────────────────────────────────────────

export interface AgentOptions {
  threadId: string;
  messageText: string;
  timeoutMs: number;
  verbose: boolean;
}

// ── Arg Parsing ──────────────────────────────────────

/**
 * Parse `roundhouse agent` CLI arguments into structured options.
 * Exits the process on invalid input.
 */
export function parseAgentArgs(argv: string[]): { options: AgentOptions; useStdin: boolean } {
  let threadId = "";
  let messageText = "";
  let useStdin = false;
  let timeoutMs = 120_000;
  let verbose = false;
  let ephemeral = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--thread" && argv[i + 1]) {
      threadId = argv[++i];
    } else if (argv[i] === "--stdin") {
      useStdin = true;
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      const val = parseInt(argv[++i], 10);
      if (isNaN(val) || val <= 0) {
        console.error("--timeout must be a positive number (seconds)");
        process.exit(1);
      }
      timeoutMs = val * 1000;
    } else if (argv[i] === "--no-timeout") {
      timeoutMs = 0;
    } else if (argv[i] === "--verbose") {
      verbose = true;
    } else if (argv[i] === "--ephemeral") {
      ephemeral = true;
    } else if (argv[i].startsWith("-")) {
      console.error(`Unknown flag: ${argv[i]}`);
      process.exit(1);
    } else {
      messageText = argv.slice(i).join(" ");
      break;
    }
  }

  if (threadId && ephemeral) {
    console.error("--thread and --ephemeral cannot be used together");
    process.exit(1);
  }

  if (!threadId) {
    threadId = ephemeral
      ? `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : "main";
  }

  return { options: { threadId, messageText, timeoutMs, verbose }, useStdin };
}

// ── Stdin Reader ─────────────────────────────────────

const MAX_STDIN_BYTES = 1024 * 1024; // 1 MB

/**
 * Read stdin with a size limit. Returns the text content.
 * Exits the process if input exceeds limit.
 */
export async function readStdinWithLimit(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_STDIN_BYTES) {
      console.error(`Input exceeds ${MAX_STDIN_BYTES / 1024}KB limit. Use a file instead.`);
      process.exit(1);
    }
    chunks.push(chunk);
  }

  let raw = Buffer.concat(chunks).toString("utf8");
  // Strip single trailing newline (shell echo adds one)
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  return raw;
}

// ── Agent Runner ─────────────────────────────────────

/**
 * Run the agent with timeout and signal handling.
 * Streams output to stdout if streaming is available.
 */
export async function runAgentWithTimeout(opts: AgentOptions): Promise<void> {
  const { threadId, messageText, timeoutMs, verbose } = opts;

  // Suppress logs unless verbose
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  if (!verbose) {
    console.log = () => {};
    console.warn = () => {};
  }

  let agent: AgentAdapter | undefined;
  let aborted = false;

  const handleSignal = async () => {
    if (aborted) return;
    aborted = true;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    try { await agent?.abort?.(threadId); } catch {}
    try { await agent?.dispose(); } catch {}
    process.exit(130);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = timeoutMs > 0
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(async () => {
          aborted = true;
          try { await agent?.abort?.(threadId); } catch {}
          reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      })
    : null;

  try {
    const config = await loadConfig();
    const { getAgentFactory } = await import("../agents/registry");
    const factory = getAgentFactory(config.agent.type);
    agent = factory(config.agent);

    const run = async () => {
      if (agent!.promptStream) {
        for await (const event of agent!.promptStream(threadId, { text: messageText })) {
          if (event.type === "text_delta") {
            process.stdout.write(event.text);
          }
        }
        process.stdout.write("\n");
      } else {
        const response = await agent!.prompt(threadId, { text: messageText });
        origLog(response.text);
      }
    };

    if (timeoutPromise) {
      await Promise.race([run(), timeoutPromise]);
    } else {
      await run();
    }
  } catch (err: any) {
    console.error = origError;
    console.error(`Error: ${err.message}`);
    process.exit(aborted ? 124 : 1);
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    if (!aborted) await agent?.dispose();
  }
}

// ── Entry Point ──────────────────────────────────────

/**
 * Main entry for `roundhouse agent` command.
 */
export async function cmdAgent(): Promise<void> {
  const { options, useStdin } = parseAgentArgs(process.argv.slice(3));

  if (useStdin) {
    options.messageText = await readStdinWithLimit();
  }

  if (!options.messageText) {
    console.error("Usage: roundhouse agent <message>");
    console.error("       roundhouse agent --thread <id> <message>");
    console.error("       echo \"message\" | roundhouse agent --stdin");
    console.error("       roundhouse agent --timeout 60 <message>");
    console.error("       roundhouse agent --verbose <message>");
    console.error("       roundhouse agent --ephemeral <message>");
    process.exit(1);
  }

  await runAgentWithTimeout(options);
}

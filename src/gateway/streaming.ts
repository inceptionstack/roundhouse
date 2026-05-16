/**
 * gateway/streaming.ts — Agent stream event handler
 *
 * Processes the async stream of agent events and routes them:
 * - text_delta → collected per-turn, sent via thread.handleStream()
 * - tool_start/end → compact status messages (verbose mode)
 * - turn_end → flush current stream, start fresh
 * - custom_message → flush and post as separate message
 */

import type { AgentStreamEvent } from "../types";
import { READ_ONLY_TOOLS } from "../memory/types";
import { isTelegramThread, handleTelegramHtmlStream } from "../transports/telegram/html";
import { DEBUG_STREAM } from "../util";
import { toolIcon } from "./helpers";
import { isContextOverflowError } from "../agents/shared/error-classifiers";

/**
 * Thrown from `handleStreaming` when a `model_error` stream event carries a
 * provider-classified context-overflow message (`prompt is too long`, etc.).
 *
 * Background: pi-ai's streaming converts provider errors into `model_error`
 * EVENTS rather than thrown exceptions. Without this class, the for-await
 * would post the raw error inline and return normally, bypassing the
 * gateway's `recoverFromAgentTurnOverflow` catch path. Throwing here
 * routes streamed-overflow into the same recovery surface used for
 * synchronous `agent.prompt()` overflow.
 *
 * Non-overflow `model_error` events still post `⚠️ Agent error: ...` inline
 * and let the stream continue — only context-overflow is escalated to a
 * thrown exception.
 */
export class StreamModelOverflowError extends Error {
  override readonly name = "StreamModelOverflowError";
  constructor(message: string) {
    super(message);
  }
}

// ── Text Stream Factory ──────────────────────────────

export function createTextStream(): {
  iterable: AsyncIterable<string>;
  push: (text: string) => void;
  finish: () => void;
} {
  let buffer = "";
  let resolve: ((value: IteratorResult<string>) => void) | null = null;
  let done = false;

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (buffer) {
            const chunk = buffer;
            buffer = "";
            return { value: chunk, done: false };
          }
          if (done) return { value: undefined as any, done: true };
          return new Promise((r) => { resolve = r; });
        },
      };
    },
  };

  return {
    iterable,
    push(text: string) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: text, done: false });
      } else {
        buffer += text;
      }
    },
    finish() {
      done = true;
      resolve?.({ value: undefined as any, done: true });
    },
  };
}

// ── Stream Handler ───────────────────────────────────

export interface StreamContext {
  thread: any;
  verbose: boolean;
  signal?: AbortSignal;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

export interface StreamResult {
  usedTools: boolean;
  /**
   * True if at least one non-empty text_delta was buffered to the chat
   * during this turn (i.e. the user saw partial assistant text before
   * the stream ended). Used by the gateway catch path to choose between
   * "please resend" vs "response was interrupted" recovery copy.
   */
  hadVisibleText: boolean;
}

/**
 * Handle the agent's event stream, routing events to the chat thread.
 */
export async function handleStreaming(
  stream: AsyncIterable<AgentStreamEvent>,
  ctx: StreamContext,
): Promise<StreamResult> {
  const { thread, verbose, signal, postWithFallback } = ctx;
  let activeTools = new Map<string, string>();
  let usedFileModifyingTools = false;

  let currentPush: ((text: string) => void) | null = null;
  let currentFinish: (() => void) | null = null;
  let currentPromise: Promise<void> | null = null;

  const flushCurrentStream = async () => {
    if (!currentPromise) return;
    currentFinish?.();
    try { await currentPromise; } catch (err) {
      console.warn(`[roundhouse] stream flush error:`, (err as Error).message);
    }
    currentPush = null;
    currentFinish = null;
    currentPromise = null;
  };

  const useTelegramHtml = isTelegramThread(thread);

  const ensureStream = () => {
    if (!currentPromise) {
      const ts = createTextStream();
      currentPush = ts.push;
      currentFinish = ts.finish;
      currentPromise = useTelegramHtml
        ? handleTelegramHtmlStream(thread, ts.iterable).catch((err: Error) => {
            console.warn(`[roundhouse] telegram html stream error:`, err.message);
          })
        : thread.handleStream(ts.iterable).catch((err: Error) => {
            console.warn(`[roundhouse] handleStream error:`, err.message);
          });
    }
  };

  let hasTextInCurrentTurn = false;
  let hasContentThisTurn = false;
  let hasVisibleText = false;
  let modelErrorPosted = false;
  let eventCount = 0;
  let drainingNotified = false;

  for await (const event of stream) {
    if (signal?.aborted) {
      console.log(`[roundhouse] stream aborted for thread`);
      break;
    }

    eventCount++;

    if (DEBUG_STREAM) {
      const preview = event.type === "text_delta" ? `"${event.text.slice(0, 30)}"`
        : event.type === "custom_message" ? `${event.customType}:${event.content.slice(0, 30)}`
        : event.type === "tool_start" || event.type === "tool_end" ? event.toolName
        : "";
      console.log(`[roundhouse/stream] #${eventCount} ${event.type} ${preview}`);
    }

    switch (event.type) {
      case "text_delta": {
        ensureStream();
        currentPush!(event.text);
        if (event.text.length > 0) hasVisibleText = true;
        hasTextInCurrentTurn = true;
        hasContentThisTurn = true;
        break;
      }

      case "tool_start": {
        activeTools.set(event.toolCallId, event.toolName);
        if (!READ_ONLY_TOOLS.has(event.toolName)) usedFileModifyingTools = true;
        hasContentThisTurn = true;
        if (verbose) {
          try { await thread.post(`${toolIcon(event.toolName)} Running \`${event.toolName}\`…`); } catch {}
        }
        break;
      }

      case "tool_end": {
        activeTools.delete(event.toolCallId);
        break;
      }

      case "custom_message": {
        if (currentPromise) {
          await flushCurrentStream();
          hasTextInCurrentTurn = false;
        }
        hasContentThisTurn = true;
        await postWithFallback(thread, event.content);
        break;
      }

      case "model_error": {
        await flushCurrentStream();
        hasTextInCurrentTurn = false;
        hasContentThisTurn = true;
        // Context-overflow is recoverable — escalate to the gateway catch
        // (recoverFromAgentTurnOverflow), suppress the raw inline post, and
        // abort the stream. Recovery posts its own ♻️/✅/⚠️ messaging.
        // Non-overflow errors keep today's inline post + continue-loop.
        if (isContextOverflowError({ message: event.message })) {
          console.warn(`[roundhouse] streamed model_error: context overflow — escalating to gateway recovery`);
          throw new StreamModelOverflowError(event.message);
        }
        modelErrorPosted = true;
        const safeMsg = event.message.split("\n")[0].slice(0, 400);
        console.warn(`[roundhouse] model error: ${safeMsg}`);
        try { await thread.post(`\u26a0\ufe0f Agent error: ${safeMsg}`); } catch {}
        break;
      }

      case "turn_end": {
        if (hasTextInCurrentTurn) {
          await flushCurrentStream();
          hasTextInCurrentTurn = false;
        }
        break;
      }

      case "draining": {
        if (hasTextInCurrentTurn) {
          await flushCurrentStream();
          hasTextInCurrentTurn = false;
        }
        try { await thread.post("⏳ Hold on — waiting for follow-up messages..."); drainingNotified = true; } catch {}
        break;
      }

      case "drain_complete": {
        if (hasTextInCurrentTurn) {
          await flushCurrentStream();
          hasTextInCurrentTurn = false;
        }
        if (drainingNotified) {
          try { await thread.post("✅ All done — waiting for your input."); } catch {}
          drainingNotified = false;
        }
        break;
      }

      case "agent_end": {
        if (hasTextInCurrentTurn) {
          await flushCurrentStream();
        }
        break;
      }
    }
  }

  if (currentPromise) {
    await flushCurrentStream();
  }

  // Safety net: if the entire turn produced no visible content and no error
  // was already reported, notify the user so they don't stare at "typing" forever.
  if (!hasContentThisTurn && !modelErrorPosted) {
    console.warn(`[roundhouse] agent returned no content this turn (${eventCount} events received)`);
    try { await thread.post("\u26a0\ufe0f Agent returned no response. Check roundhouse logs."); } catch {}
  }

  return { usedTools: usedFileModifyingTools, hadVisibleText: hasVisibleText };
}

/**
 * transports/composite.ts — Composite transport adapter
 *
 * Routes calls across multiple `TransportAdapter` delegates. Lets the
 * gateway run multiple chat platforms (Telegram + Slack) under a single
 * `this.transport` field, with no per-call branching.
 *
 * Routing rules:
 *   - Per-thread methods (postMessage/postRich/progress/stream/enrichPrompt):
 *     dispatch to the first delegate where `ownsThread(thread)` is true.
 *   - `notify(chatIds, …)`: partition chatIds by `ownsChatId`, fan out.
 *   - `createThread(chatId)`: route by `ownsChatId`.
 *   - `encodeParentThreadId` / `formatNotifySession`: route by `ownsChatId`.
 *   - `registerCommands` / `dispose` / `isPairingPending`: fan out to all.
 *   - `handlePairing`: walk delegates, return first non-null. Decorates
 *     the result with the delegate's `name` so the gateway can mark
 *     `pairingComplete` per-transport.
 *   - `shouldIgnoreMessage`: routed by `ownsThread`.
 *
 * If no delegate owns a thread / chat id, per-thread/per-chatId methods
 * log + drop. This matches the existing best-effort post model.
 */

import type {
  TransportAdapter,
  ChatThread,
  IncomingMessage,
  PairingResult,
  RichResponse,
  ProgressMessage,
} from "./types";

/** No-op progress message — used as a fallback when no delegate owns the thread. */
const NOOP_PROGRESS: ProgressMessage = { update: async () => {} };

export class CompositeTransportAdapter implements TransportAdapter {
  readonly name = "composite";
  readonly delegates: ReadonlyArray<TransportAdapter>;

  constructor(delegates: TransportAdapter[]) {
    if (delegates.length === 0) {
      throw new Error("CompositeTransportAdapter requires at least one delegate");
    }
    this.delegates = delegates;
  }

  /** Find the delegate (if any) that owns `thread`. Public so gateway can map thread → transport name. */
  ownerOf(thread: ChatThread): TransportAdapter | null {
    return this.delegates.find(d => d.ownsThread(thread)) ?? null;
  }

  /** Find the delegate (if any) that recognizes `chatId`. */
  ownerOfChatId(id: string | number): TransportAdapter | null {
    return this.delegates.find(d => d.ownsChatId(id)) ?? null;
  }

  enrichPrompt(thread: ChatThread, text: string): string {
    const owner = this.ownerOf(thread);
    return owner ? owner.enrichPrompt(thread, text) : text;
  }

  async postMessage(thread: ChatThread, text: string): Promise<void> {
    const owner = this.ownerOf(thread);
    if (!owner) {
      console.warn(`[composite] postMessage: no delegate owns thread ${thread.id}; dropping`);
      return;
    }
    await owner.postMessage(thread, text);
  }

  async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
    const owner = this.ownerOf(thread);
    if (!owner) {
      console.warn(`[composite] postRich: no delegate owns thread ${thread.id}; dropping`);
      return;
    }
    await owner.postRich(thread, response);
  }

  async progress(thread: ChatThread, initialText: string): Promise<ProgressMessage> {
    const owner = this.ownerOf(thread);
    if (!owner) {
      console.warn(`[composite] progress: no delegate owns thread ${thread.id}; returning no-op`);
      return NOOP_PROGRESS;
    }
    return owner.progress(thread, initialText);
  }

  async stream(thread: ChatThread, iter: AsyncIterable<string>, signal?: AbortSignal): Promise<void> {
    const owner = this.ownerOf(thread);
    if (!owner) {
      console.warn(`[composite] stream: no delegate owns thread ${thread.id}; dropping`);
      return;
    }
    await owner.stream(thread, iter, signal);
  }

  async registerCommands(): Promise<void> {
    // Fan out — each delegate self-sources its own creds and no-ops if missing.
    await Promise.all(this.delegates.map(d => d.registerCommands().catch(err => {
      console.warn(`[composite] ${d.name}.registerCommands failed:`, (err as Error).message);
    })));
  }

  ownsThread(thread: ChatThread): boolean {
    return this.delegates.some(d => d.ownsThread(thread));
  }

  ownsChatId(id: string | number): boolean {
    return this.delegates.some(d => d.ownsChatId(id));
  }

  encodeParentThreadId(chatId: string | number): string {
    const owner = this.ownerOfChatId(chatId);
    if (!owner) {
      throw new Error(`No transport recognizes chat id ${chatId}`);
    }
    return owner.encodeParentThreadId(chatId);
  }

  formatNotifySession(chatId: string | number): string {
    const owner = this.ownerOfChatId(chatId);
    return owner ? owner.formatNotifySession(chatId) : "main";
  }

  async notify(chatIds: (string | number)[], text: string): Promise<void> {
    // Partition by delegate, then fan out. Delegates also filter internally,
    // so this is partly defensive — but it lets us avoid calling notify on
    // delegates that have nothing to do, which keeps logs quiet.
    const buckets = new Map<TransportAdapter, (string | number)[]>();
    for (const id of chatIds) {
      const owner = this.ownerOfChatId(id);
      if (!owner) {
        console.warn(`[composite] notify: no delegate owns chat id ${id}; skipping`);
        continue;
      }
      const list = buckets.get(owner) ?? [];
      list.push(id);
      buckets.set(owner, list);
    }
    await Promise.all(
      [...buckets.entries()].map(([d, ids]) =>
        d.notify(ids, text).catch(err => {
          console.warn(`[composite] ${d.name}.notify failed:`, (err as Error).message);
        }),
      ),
    );
  }

  createThread(chatId: string | number): ChatThread {
    const owner = this.ownerOfChatId(chatId);
    if (!owner) {
      throw new Error(`No transport recognizes chat id ${chatId} for createThread`);
    }
    return owner.createThread(chatId);
  }

  async isPairingPending(): Promise<boolean> {
    const flags = await Promise.all(this.delegates.map(d => d.isPairingPending().catch(() => false)));
    return flags.some(Boolean);
  }

  async handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null> {
    // Walk delegates in order. The first that returns non-null wins. We
    // attach `transport: d.name` so the gateway can mark `pairingComplete`
    // per-transport.
    for (const d of this.delegates) {
      const result = await d.handlePairing(thread, message);
      if (result) {
        return { ...result, transport: result.transport ?? d.name };
      }
    }
    return null;
  }

  shouldIgnoreMessage(text: string, message: IncomingMessage, thread: ChatThread): boolean {
    const owner = this.ownerOf(thread);
    if (!owner?.shouldIgnoreMessage) return false;
    return owner.shouldIgnoreMessage(text, message, thread);
  }
}

/**
 * Convenience: build a composite from the configured chat-adapter map keys.
 * Always wraps in a composite even for a single delegate so the gateway
 * has a uniform interface.
 */
export function buildCompositeTransport(delegates: TransportAdapter[]): CompositeTransportAdapter {
  return new CompositeTransportAdapter(delegates);
}

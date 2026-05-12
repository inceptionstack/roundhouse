/**
 * gateway/command-registry.ts — Descriptor-based command registration
 *
 * Problem: previously, adding a new Telegram command required editing
 * `gateway.ts` in 2–3 places (import, text-dispatch branch, onAction
 * subscription). That's an OCP violation — gateway wasn't closed for
 * modification. At 2 commands it was fine. At 5–8 it becomes noise.
 *
 * Solution: each command module exports a `CommandDescriptor` bundling
 * its trigger tokens, an `invoke()` closure, optional inline-keyboard
 * action handlers, and a `stage` hint. The gateway iterates a single
 * `COMMANDS` array to wire everything. Adding a new command = one new
 * descriptor + one line in the array.
 *
 * Pattern: Command (GoF) + Observer registration. Not a Mediator — the
 * gateway is still the composition root, it just stops special-casing.
 *
 * Stages:
 *   - "pre-turn"  fires before the allowlist/pairing gate inside
 *                 handleOrAbort(). Used for abort-style commands like
 *                 /stop that must interrupt an in-flight agent run.
 *                 Handlers own their own allowlist check if needed.
 *   - "in-turn"   fires inside the main message handler, after pairing,
 *                 allowlist, and the "is this even text" guards. The
 *                 default — most commands belong here.
 *
 * Action handlers (inline-keyboard callbacks) are registered unconditionally
 * at startup via chat.onAction(). The gateway doesn't care which descriptor
 * owns which action id.
 */

import type { ChatThreadLike } from "./inline-keyboard";

/** Dispatch stages — see module doc. */
export type CommandStage = "pre-turn" | "in-turn";

/**
 * What the gateway passes to a descriptor's `invoke()`. Thin by design —
 * the command closure captures everything else from its own module or
 * from the gateway's `buildCommandContext()`.
 */
export interface CommandInvocation {
  /** The chat thread (subscribed). */
  thread: any;
  /** The raw incoming message object from the Chat SDK. */
  message: any;
  /** The already-trimmed text of the message. */
  text: string;
  /** The resolved agent thread id (post topic-override). */
  agentThreadId: string;
}

/**
 * Inline-keyboard callback event shape. Matches what
 * `chat.onAction(actionId, handler)` already provides today.
 */
export interface ActionInvocation {
  value?: string;
  thread: ChatThreadLike;
}

/**
 * A single command's self-describing registration metadata.
 *
 * Design notes:
 * - `triggers` is a list so we can declare aliases like `/crons` + `/jobs`
 *   without duplicating descriptors.
 * - `acceptsArgs` controls whether we match `/cmd foo` as well as bare
 *   `/cmd` (maps to the existing `isCommandWithArgs` helper).
 * - `invoke` is the closure that does the actual work. It returns `void`
 *   but may be `async`. The gateway awaits it and then short-circuits
 *   further dispatch — so descriptors are "run first match wins".
 * - `actions` wires `chat.onAction(id, …)` at startup. Keys are the
 *   ACTION_ID constants, values are handler closures. Co-locates button
 *   protocol with the command that owns it (SRP).
 */
export interface CommandDescriptor {
  /** Command strings including the leading slash, e.g. `"/topic"`. */
  triggers: readonly string[];
  /** Default `"in-turn"`. */
  stage?: CommandStage;
  /** If true, `/cmd arg1 arg2` also matches. Default false. */
  acceptsArgs?: boolean;
  /** Do the work. Return (or resolve) when done — gateway will skip further dispatch. */
  invoke: (inv: CommandInvocation) => Promise<void> | void;
  /** Optional inline-keyboard callback handlers keyed by action id. */
  actions?: Record<string, (inv: ActionInvocation) => Promise<void> | void>;
}

/**
 * Helper: has this descriptor opted into pre-turn dispatch?
 * Extracted as a tiny predicate so gateway.ts reads naturally:
 *   `if (isPreTurn(cmd)) { … }`
 */
export function isPreTurn(cmd: CommandDescriptor): boolean {
  return cmd.stage === "pre-turn";
}

/**
 * Does `text` invoke any of this descriptor's triggers?
 *
 * Matching is delegated to the caller via `matchers` so this module doesn't
 * depend on the specific `isCommand` / `isCommandWithArgs` implementations
 * (keeps it pure & unit-testable). `acceptsArgs` controls whether the
 * args-matcher is also consulted.
 */
export interface CommandMatchers {
  /** Exact-match: `/cmd` or `/cmd@botname`, no trailing args. */
  isCommand: (text: string, cmd: string) => boolean;
  /** Args-match: `/cmd arg1` or `/cmd@botname arg1 arg2`. */
  isCommandWithArgs: (text: string, cmd: string) => boolean;
}

export function matchesDescriptor(
  desc: CommandDescriptor,
  text: string,
  matchers: CommandMatchers,
): boolean {
  for (const trigger of desc.triggers) {
    if (matchers.isCommand(text, trigger)) return true;
    if (desc.acceptsArgs && matchers.isCommandWithArgs(text, trigger)) return true;
  }
  return false;
}

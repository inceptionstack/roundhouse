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

import type { RichResponse, MinimalThread } from "../transports";

/**
 * Minimal thread shape an action handler reads. Intentionally narrow so
 * the registry doesn't depend on Chat SDK or transport-specific types.
 * The transport adapter does the heavy lifting downstream.
 */
export interface ActionThreadLike {
  id?: string;
  [key: string]: unknown;
}

/**
 * What a command's `invoke()` or action handler may return.
 *
 * - `void`: the handler did its own posting (legacy path).
 * - `RichResponse`: gateway dispatches to `transport.postRich(thread, result)`.
 */
export type CommandResult = void | RichResponse;

/** Dispatch stages — see module doc. */
export type CommandStage = "pre-turn" | "in-turn";

/**
 * What the gateway passes to a descriptor's `invoke()`. Thin by design —
 * the command closure captures everything else from its own module or
 * from the gateway's `buildCommandContext()`.
 */
export interface CommandInvocation {
  /** The chat thread (subscribed). Narrow shape — commands only need id + post. */
  thread: MinimalThread;
  /** The raw incoming message object from the Chat SDK. */
  message: { text?: string; [key: string]: unknown };
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
  thread: ActionThreadLike;
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
  /** Do the work. Return (or resolve) when done — gateway will skip further dispatch.
   *  May return a RichResponse for the gateway to render via the active transport. */
  invoke: (inv: CommandInvocation) => Promise<CommandResult> | CommandResult;
  /** Optional inline-keyboard callback handlers keyed by action id. May return a RichResponse. */
  actions?: Record<string, (inv: ActionInvocation) => Promise<CommandResult> | CommandResult>;
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

/**
 * Validate that no two descriptors claim the same action id.
 *
 * Why: duplicate registrations at `chat.onAction(actionId, …)` produce
 * silent misbehavior — last-wins on some adapters, double-fire on others.
 * Failing fast at startup makes the coupling surface explicit.
 *
 * Throws on the first collision with both owners' trigger lists for easy
 * diagnosis. Returns the set of (actionId, handler) pairs in registration
 * order so the caller can iterate without re-walking descriptors.
 */
export function collectAndValidateActions(
  descriptors: readonly CommandDescriptor[],
): Array<{ actionId: string; handler: NonNullable<CommandDescriptor["actions"]>[string]; ownerTriggers: readonly string[] }> {
  type ActionHandler = NonNullable<CommandDescriptor["actions"]>[string];
  const result: Array<{ actionId: string; handler: ActionHandler; ownerTriggers: readonly string[] }> = [];
  const ownerByAction = new Map<string, readonly string[]>();

  for (const desc of descriptors) {
    if (!desc.actions) continue;
    for (const [actionId, handler] of Object.entries(desc.actions)) {
      const prior = ownerByAction.get(actionId);
      if (prior) {
        throw new Error(
          `[command-registry] duplicate action id '${actionId}': claimed by ` +
          `[${prior.join(",")}] and [${desc.triggers.join(",")}]. Action IDs must be unique.`,
        );
      }
      ownerByAction.set(actionId, desc.triggers);
      result.push({ actionId, handler, ownerTriggers: desc.triggers });
    }
  }
  return result;
}

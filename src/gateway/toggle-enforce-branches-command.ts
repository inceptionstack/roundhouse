/**
 * gateway/toggle-enforce-branches-command.ts — /toggle-enforce-branches command
 *
 * Toggles the runtime kill-switch for `@inceptionstack/pi-branch-enforcer`.
 *
 * The extension (v3.3.0+) checks for `~/.pi-branch-enforcer/disabled` on every
 * `tool_call`. Creating the file disables enforcement; removing it re-enables.
 * Effect is **immediate** — no agent restart needed; the next bash command
 * sees the new state.
 *
 * Usage:
 *   /toggle-enforce-branches            → toggle (off→on or on→off)
 *   /toggle-enforce-branches on         → force enable
 *   /toggle-enforce-branches off        → force disable
 *   /toggle-enforce-branches status     → just report current state
 *
 * The command intentionally lives in roundhouse rather than the extension so
 * that the user-facing surface (Telegram) stays in one place. The extension
 * just exposes the marker file as a stable contract.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";

/** Stable contract with pi-branch-enforcer >=3.3.0. */
const MARKER_DIR = join(homedir(), ".pi-branch-enforcer");
const MARKER_PATH = join(MARKER_DIR, "disabled");

export interface ToggleEnforceBranchesContext {
  thread: any;
  text: string;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

/** True if enforcement is currently disabled (marker file present). */
function isDisabled(): boolean {
  try { return existsSync(MARKER_PATH); } catch { return false; }
}

/** Create the marker file (disable enforcement). Idempotent. */
function disable(): void {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(MARKER_PATH, `disabled at ${new Date().toISOString()}\n`);
}

/** Remove the marker file (re-enable enforcement). Idempotent. */
function enable(): void {
  try { unlinkSync(MARKER_PATH); } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function statusLine(disabled: boolean): string {
  return disabled
    ? "🔓 *Branch enforcer:* DISABLED — pushes to `main`/`master` are allowed"
    : "🔒 *Branch enforcer:* ENABLED — pushes to `main`/`master` are blocked";
}

export async function handleToggleEnforceBranches(ctx: ToggleEnforceBranchesContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;
  const arg = text.split(/\s+/)[1]?.toLowerCase() ?? "";

  // Pure status query — no state change.
  if (arg === "status") {
    await postWithFallback(thread, statusLine(isDisabled()));
    return;
  }

  // Resolve target state.
  const currentlyDisabled = isDisabled();
  let targetDisabled: boolean;
  if (arg === "on" || arg === "enable") {
    targetDisabled = false;
  } else if (arg === "off" || arg === "disable") {
    targetDisabled = true;
  } else if (arg === "" || arg === "toggle") {
    targetDisabled = !currentlyDisabled;
  } else {
    await postWithFallback(
      thread,
      "Usage: `/toggle-enforce-branches [on|off|status]`\n\n" +
      "_(no arg toggles the current state)_",
    );
    return;
  }

  // Apply.
  try {
    if (targetDisabled) disable(); else enable();
  } catch (err) {
    await postWithFallback(thread, `⚠️ Failed to toggle: ${(err as Error).message}`);
    return;
  }

  const noChange = targetDisabled === currentlyDisabled;
  const prefix = noChange ? "ℹ️ Already in target state.\n\n" : "✅ Updated.\n\n";
  const detail = targetDisabled
    ? "\n\n_Effect:_ next `bash` tool call will skip enforcement. Re-enable with `/toggle-enforce-branches on`."
    : "\n\n_Effect:_ next `bash` tool call will resume enforcement.";
  await postWithFallback(thread, prefix + statusLine(targetDisabled) + detail);

  console.log(
    `[roundhouse] /toggle-enforce-branches: ${currentlyDisabled ? "disabled" : "enabled"} → ` +
    `${targetDisabled ? "disabled" : "enabled"}`,
  );
}

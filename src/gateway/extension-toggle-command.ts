/**
 * gateway/extension-toggle-command.ts — Toggle pi-hard-no & pi-branch-enforcer
 *
 * Idempotent setter semantics:
 *   /toggle-quality-inspector [on|off]
 *   /toggle-branch-enforcer [on|off]
 *
 * No arg → show current state + inline keyboard with [ON] [OFF] buttons.
 * Explicit on/off → enable/disable package, return confirmation.
 *
 * Stage: pre-turn (control-plane mutation, works during in-flight agent turn).
 */

import type { RichResponse } from "../transports";
import { buildSelectableMenu } from "../transports";
import {
  enablePiPackage,
  disablePiPackage,
  isPiPackageEnabled,
  MalformedPiSettingsError,
} from "../pi-settings";

/** Distinct action IDs to avoid duplicate-action-id rejection. */
export const EXT_TOGGLE_QI_ACTION_ID = "ext_toggle_qi";
export const EXT_TOGGLE_BE_ACTION_ID = "ext_toggle_be";

/** Package identifiers. */
const QI_PACKAGE = "npm:@inceptionstack/pi-hard-no";
const BE_PACKAGE = "npm:@inceptionstack/pi-branch-enforcer";

export interface ExtToggleContext {
  text: string;
}

/**
 * Parse desired state from command text.
 * `/toggle-quality-inspector on` → "on"
 * `/toggle-quality-inspector off` → "off"
 * `/toggle-quality-inspector` → null (show menu)
 */
function parseDesiredState(text: string): "on" | "off" | null {
  const parts = text.trim().split(/\s+/);
  const arg = parts[1]?.toLowerCase();
  if (arg === "on") return "on";
  if (arg === "off") return "off";
  return null;
}

/**
 * Shared handler for both toggle commands.
 */
async function handleExtensionToggle(
  pkg: string,
  label: string,
  actionId: string,
  ctx: ExtToggleContext,
): Promise<RichResponse> {
  const desired = parseDesiredState(ctx.text);

  try {
    // No arg → show current state + ON/OFF inline keyboard
    if (desired === null) {
      const enabled = await isPiPackageEnabled(pkg);
      return buildSelectableMenu({
        current: enabled ? "on" : "off",
        options: [
          { key: "on", label: "ON" },
          { key: "off", label: "OFF" },
        ],
        actionId,
        textHeader: `${enabled ? "✅" : "🚫"} *${label}:* ${enabled ? "ON" : "OFF"}`,
        textHint: `_Usage:_ \`/toggle-${actionId === EXT_TOGGLE_QI_ACTION_ID ? "quality-inspector" : "branch-enforcer"} on|off\``,
        columns: 2,
      });
    }

    // Explicit setter — idempotent
    const { changed } = desired === "on"
      ? await enablePiPackage(pkg)
      : await disablePiPackage(pkg);

    const icon = desired === "on" ? "✅" : "🚫";
    const state = desired === "on" ? "ON" : "OFF";
    const note = changed ? "\n\nRestart pi to apply: /restart" : "\n\n(no change)";
    return { text: `${icon} ${label}: ${state}${note}` };
  } catch (err) {
    if (err instanceof MalformedPiSettingsError) {
      return {
        text: `⚠️ ~/.pi/agent/settings.json is malformed. Refusing to write.\nRun /doctor to inspect.\n\n\`${err.message}\``,
      };
    }
    throw err;
  }
}

export async function handleToggleQualityInspector(ctx: ExtToggleContext): Promise<RichResponse> {
  return handleExtensionToggle(QI_PACKAGE, "Quality inspector (pi-hard-no)", EXT_TOGGLE_QI_ACTION_ID, ctx);
}

export async function handleToggleBranchEnforcer(ctx: ExtToggleContext): Promise<RichResponse> {
  return handleExtensionToggle(BE_PACKAGE, "Branch enforcer (pi-branch-enforcer)", EXT_TOGGLE_BE_ACTION_ID, ctx);
}

/**
 * Inline-keyboard click handler for quality inspector.
 * Button value is just "on" or "off" (≤3 bytes, well under Telegram's 64-byte limit).
 */
export async function handleExtToggleQiAction(event: { value?: string }): Promise<RichResponse | void> {
  const state = event.value;
  if (state !== "on" && state !== "off") return;
  try {
    const { changed } = state === "on"
      ? await enablePiPackage(QI_PACKAGE)
      : await disablePiPackage(QI_PACKAGE);
    const icon = state === "on" ? "✅" : "🚫";
    const label = "Quality inspector (pi-hard-no)";
    const note = changed ? "\n\nRestart pi to apply: /restart" : "\n\n(no change)";
    return { text: `${icon} ${label}: ${state.toUpperCase()}${note}` };
  } catch (err) {
    if (err instanceof MalformedPiSettingsError) {
      return { text: `⚠️ settings.json malformed. Run /doctor.` };
    }
    throw err;
  }
}

/**
 * Inline-keyboard click handler for branch enforcer.
 */
export async function handleExtToggleBeAction(event: { value?: string }): Promise<RichResponse | void> {
  const state = event.value;
  if (state !== "on" && state !== "off") return;
  try {
    const { changed } = state === "on"
      ? await enablePiPackage(BE_PACKAGE)
      : await disablePiPackage(BE_PACKAGE);
    const icon = state === "on" ? "✅" : "🚫";
    const label = "Branch enforcer (pi-branch-enforcer)";
    const note = changed ? "\n\nRestart pi to apply: /restart" : "\n\n(no change)";
    return { text: `${icon} ${label}: ${state.toUpperCase()}${note}` };
  } catch (err) {
    if (err instanceof MalformedPiSettingsError) {
      return { text: `⚠️ settings.json malformed. Run /doctor.` };
    }
    throw err;
  }
}

/**
 * ipc/types.ts — Shared types for the IPC protocol
 */

/** Messages the CLI can send to the gateway */
export type IpcRequest =
  | { type: "notify"; text: string; session?: string }
  | { type: "ping" };

/** Responses the gateway sends back */
export type IpcResponse =
  | { ok: true }
  | { ok: false; error: string };

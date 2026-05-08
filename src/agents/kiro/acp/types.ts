/**
 * acp/types.ts — ACP (Agent Control Protocol) type definitions
 *
 * Discriminated union of events received from kiro-cli over JSON-RPC stdio.
 */

// ── Stop reasons ─────────────────────────────────────

export type StopReason = "end_turn" | "cancelled" | "max_turns" | "error";

// ── ACP Events (notifications from kiro-cli) ─────────

export interface AcpTextChunk {
  type: "text_chunk";
  text: string;
}

export interface AcpThinkingChunk {
  type: "thinking_chunk";
  text: string;
}

export interface AcpToolCall {
  type: "tool_call";
  tool_call_id: string;
  title: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_kind?: string;
}

export interface AcpToolResult {
  type: "tool_result";
  tool_call_id: string;
  output: string;
  exit_code: number;
}

export interface AcpPermissionRequest {
  type: "permission_request";
  tool_call_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  title?: string;
}

export interface AcpComplete {
  type: "complete";
  stop_reason: StopReason;
  error?: string;
}

export interface AcpSessionUpdate {
  type: "session/update";
  context_tokens?: number;
  context_window?: number;
  model?: string;
}

export type AcpEvent =
  | AcpTextChunk
  | AcpThinkingChunk
  | AcpToolCall
  | AcpToolResult
  | AcpPermissionRequest
  | AcpComplete
  | AcpSessionUpdate;

// ── ACP method results ───────────────────────────────

export interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
  restored: boolean;
}

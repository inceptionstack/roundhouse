/**
 * acp/methods.ts — JSON-RPC method names and event discriminators used by
 * kiro-cli's ACP protocol. Centralized here so a protocol rev only touches
 * this file.
 */

/** Methods the client calls on the agent. */
export const AcpMethod = {
  Initialize: "initialize",
  SessionNew: "session/new",
  SessionLoad: "session/load",
  SessionPrompt: "session/prompt",
  SessionCancel: "session/cancel",
  /** Internal kiro extension — e.g. running `/compact`. */
  KiroCommandsExecute: "_kiro.dev/commands/execute",
} as const;

/** Notifications the agent emits to the client. */
export const AcpEvent = {
  SessionUpdate: "session/update",
  /** Internal kiro variant emitted alongside `session/update` for some payloads. */
  KiroSessionUpdate: "_kiro.dev/session/update",
  KiroMetadata: "_kiro.dev/metadata",
} as const;

/** Discriminator values inside a `session/update` notification's `update.sessionUpdate`. */
export const SessionUpdateKind = {
  AgentMessageChunk: "agent_message_chunk",
  ToolCall: "tool_call",
  ToolCallUpdate: "tool_call_update",
} as const;

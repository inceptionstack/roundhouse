/**
 * agents/pi/message-format.ts — Message formatting utilities for Pi adapter
 *
 * Pure functions that transform AgentMessage → pi prompt text
 * and extract custom messages from session events.
 */

import type { AgentMessage } from "../../types";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Convert custom message content (string or array of parts) to plain text.
 */
export function customContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as any).type === "text"
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/**
 * Extract displayable text from a session event if it is an extension custom
 * message (e.g. pi-lgtm review) with display=true. Returns null otherwise.
 */
export function extractCustomMessage(event: AgentSessionEvent): { customType: string; content: string } | null {
  if (event.type !== "message_end") return null;
  const message = (event as any).message;
  if (!message || message.role !== "custom" || !message.display) return null;
  const content = customContentToText(message.content);
  if (!content.trim()) return null;
  const customType = message.customType ?? "";
  return { customType, content };
}

/**
 * Format an AgentMessage into the text string that pi's session.prompt() expects.
 * Handles attachment manifests with transcription data.
 */
export function formatMessage(message: AgentMessage): string {
  let text = message.text;
  if (message.attachments?.length) {
    const manifest = JSON.stringify(
      message.attachments.map((a) => {
        const entry: Record<string, unknown> = {
          id: a.id,
          type: a.mediaType,
          name: a.name,
          localPath: a.localPath,
          mime: a.mime,
          sizeBytes: a.sizeBytes,
          untrusted: true,
        };
        if (a.transcript?.status === "completed" && a.transcript.text) {
          entry.transcript = {
            text: a.transcript.text,
            language: a.transcript.language,
            provider: a.transcript.provider,
            approximate: true,
          };
        } else if (a.transcript?.status === "failed") {
          entry.transcript = {
            status: "failed",
            error: a.transcript.error,
            approximate: true,
          };
        }
        return entry;
      }),
      null,
      2,
    );
    const block = [
      "Chat attachments saved locally. Inspect files with tools before making claims. Transcripts are approximate; use the raw file if exact wording matters.",
      "```json",
      manifest,
      "```",
    ].join("\n");
    text = text ? `${text}\n\n${block}` : block;
  }
  return text;
}

/**
 * Characterization tests for pi/message-format.ts
 * Pin existing behavior per Feathers Ch. 13
 */
import { describe, test, expect } from "vitest";
import { formatMessage, extractCustomMessage, customContentToText } from "../src/agents/pi/message-format";

describe("customContentToText", () => {
  test("string content returns as-is", () => {
    expect(customContentToText("hello")).toBe("hello");
  });

  test("array of text parts joins them", () => {
    const parts = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(customContentToText(parts)).toBe("Hello world");
  });

  test("filters out non-text parts", () => {
    const parts = [
      { type: "text", text: "a" },
      { type: "image", url: "..." },
      { type: "text", text: "b" },
    ];
    expect(customContentToText(parts)).toBe("ab");
  });

  test("null/undefined returns empty string", () => {
    expect(customContentToText(null)).toBe("");
    expect(customContentToText(undefined)).toBe("");
  });

  test("number returns empty string", () => {
    expect(customContentToText(42)).toBe("");
  });

  test("empty array returns empty string", () => {
    expect(customContentToText([])).toBe("");
  });
});

describe("extractCustomMessage", () => {
  test("returns null for non-message_end events", () => {
    expect(extractCustomMessage({ type: "message_start" } as any)).toBeNull();
    expect(extractCustomMessage({ type: "message_update" } as any)).toBeNull();
  });

  test("returns null for non-custom role", () => {
    const event = { type: "message_end", message: { role: "assistant", content: "hi" } };
    expect(extractCustomMessage(event as any)).toBeNull();
  });

  test("returns null when display is false", () => {
    const event = { type: "message_end", message: { role: "custom", display: false, content: "hi" } };
    expect(extractCustomMessage(event as any)).toBeNull();
  });

  test("returns null for empty content", () => {
    const event = { type: "message_end", message: { role: "custom", display: true, content: "   " } };
    expect(extractCustomMessage(event as any)).toBeNull();
  });

  test("extracts custom message with string content", () => {
    const event = {
      type: "message_end",
      message: { role: "custom", display: true, content: "Review passed", customType: "lgtm" },
    };
    const result = extractCustomMessage(event as any);
    expect(result).toEqual({ customType: "lgtm", content: "Review passed" });
  });

  test("extracts with array content", () => {
    const event = {
      type: "message_end",
      message: {
        role: "custom",
        display: true,
        content: [{ type: "text", text: "Done" }],
        customType: "status",
      },
    };
    const result = extractCustomMessage(event as any);
    expect(result).toEqual({ customType: "status", content: "Done" });
  });

  test("defaults customType to empty string", () => {
    const event = {
      type: "message_end",
      message: { role: "custom", display: true, content: "hi" },
    };
    const result = extractCustomMessage(event as any);
    expect(result?.customType).toBe("");
  });
});

describe("formatMessage", () => {
  test("text-only message returns text", () => {
    expect(formatMessage({ text: "hello" })).toBe("hello");
  });

  test("empty text returns empty string", () => {
    expect(formatMessage({ text: "" })).toBe("");
  });

  test("message with attachments appends JSON manifest", () => {
    const msg = {
      text: "Check this",
      attachments: [{
        id: "att1",
        mediaType: "image",
        name: "photo.jpg",
        localPath: "/tmp/photo.jpg",
        mime: "image/jpeg",
        sizeBytes: 1024,
      }],
    };
    const result = formatMessage(msg);
    expect(result).toContain("Check this");
    expect(result).toContain("```json");
    expect(result).toContain('"id": "att1"');
    expect(result).toContain('"untrusted": true');
  });

  test("attachment-only message (no text) produces manifest only", () => {
    const msg = {
      text: "",
      attachments: [{
        id: "att1",
        mediaType: "audio",
        name: "voice.ogg",
        localPath: "/tmp/voice.ogg",
        mime: "audio/ogg",
        sizeBytes: 5000,
      }],
    };
    const result = formatMessage(msg);
    expect(result).toContain("```json");
    expect(result).not.toContain("\n\n```json"); // no leading \n\n when text is empty
  });

  test("includes transcript data when available", () => {
    const msg = {
      text: "voice",
      attachments: [{
        id: "att1",
        mediaType: "audio",
        name: "msg.ogg",
        localPath: "/tmp/msg.ogg",
        mime: "audio/ogg",
        sizeBytes: 2000,
        transcript: { status: "completed" as const, text: "Hello world", language: "en", provider: "whisper" },
      }],
    };
    const result = formatMessage(msg);
    expect(result).toContain('"text": "Hello world"');
    expect(result).toContain('"approximate": true');
  });

  test("includes failed transcript status", () => {
    const msg = {
      text: "voice",
      attachments: [{
        id: "att1",
        mediaType: "audio",
        name: "msg.ogg",
        localPath: "/tmp/msg.ogg",
        mime: "audio/ogg",
        sizeBytes: 2000,
        transcript: { status: "failed" as const, error: "timeout" },
      }],
    };
    const result = formatMessage(msg);
    expect(result).toContain('"status": "failed"');
    expect(result).toContain('"error": "timeout"');
  });
});

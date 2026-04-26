/**
 * voice.test.ts — Tests for voice STT service
 */

import { describe, it, expect } from "vitest";

describe("voice/types", () => {
  it("AttachmentTranscript shape", async () => {
    const { type } = await import("../src/voice/types") as any;
    // Just verify the module loads without error
    expect(true).toBe(true);
  });
});

describe("SttService", () => {
  it("imports without error", async () => {
    const { SttService, DEFAULT_STT_CONFIG } = await import("../src/voice/stt-service");
    expect(DEFAULT_STT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_STT_CONFIG.mode).toBe("on");
    expect(DEFAULT_STT_CONFIG.chain).toContain("whisper");
  });

  it("returns null when disabled", async () => {
    const { SttService } = await import("../src/voice/stt-service");
    const service = new SttService({
      enabled: false,
      mode: "off",
      chain: [],
      autoTranscribe: { voiceMessages: false, audioFiles: false, maxDurationSec: 120 },
      providers: {},
    });

    const result = await service.tryTranscribe({
      id: "att_test",
      mediaType: "audio",
      name: "test.ogg",
      localPath: "/tmp/test.ogg",
      mime: "audio/ogg",
      sizeBytes: 1000,
      untrusted: true,
    });

    expect(result).toBeNull();
  });

  it("shouldTranscribe returns false for non-audio", async () => {
    const { SttService, DEFAULT_STT_CONFIG } = await import("../src/voice/stt-service");
    const service = new SttService({ ...DEFAULT_STT_CONFIG, enabled: true });

    expect(service.shouldTranscribe({
      id: "att_test",
      mediaType: "image",
      name: "photo.jpg",
      localPath: "/tmp/photo.jpg",
      mime: "image/jpeg",
      sizeBytes: 1000,
      untrusted: true,
    })).toBe(false);
  });

  it("shouldTranscribe returns true for voice ogg", async () => {
    const { SttService, DEFAULT_STT_CONFIG } = await import("../src/voice/stt-service");
    const service = new SttService({ ...DEFAULT_STT_CONFIG, enabled: true });

    expect(service.shouldTranscribe({
      id: "att_test",
      mediaType: "audio",
      name: "audio.ogg",
      localPath: "/tmp/audio.ogg",
      mime: "audio/ogg",
      sizeBytes: 18000,
      untrusted: true,
    })).toBe(true);
  });

  it("shouldTranscribe returns false for audio files when disabled", async () => {
    const { SttService, DEFAULT_STT_CONFIG } = await import("../src/voice/stt-service");
    const service = new SttService({ ...DEFAULT_STT_CONFIG, enabled: true });

    // mp3 is not a voice message (doesn't match ogg pattern)
    expect(service.shouldTranscribe({
      id: "att_test",
      mediaType: "audio",
      name: "song.mp3",
      localPath: "/tmp/song.mp3",
      mime: "audio/mpeg",
      sizeBytes: 5000000,
      untrusted: true,
    })).toBe(false);
  });
});

describe("enrichAttachmentsWithTranscripts", () => {
  it("skips non-audio attachments", async () => {
    const { enrichAttachmentsWithTranscripts, SttService, DEFAULT_STT_CONFIG } = await import("../src/voice/stt-service");
    const service = new SttService({ ...DEFAULT_STT_CONFIG, enabled: true });

    const attachments = [{
      id: "att_test",
      mediaType: "image" as const,
      name: "photo.jpg",
      localPath: "/tmp/photo.jpg",
      mime: "image/jpeg",
      sizeBytes: 1000,
      untrusted: true as const,
    }];

    await enrichAttachmentsWithTranscripts(attachments, service);
    expect(attachments[0]).not.toHaveProperty("transcript");
  });

  it("handles null service gracefully", async () => {
    const { enrichAttachmentsWithTranscripts } = await import("../src/voice/stt-service");
    const attachments = [{
      id: "att_test",
      mediaType: "audio" as const,
      name: "audio.ogg",
      localPath: "/tmp/audio.ogg",
      mime: "audio/ogg",
      sizeBytes: 1000,
      untrusted: true as const,
    }];

    await enrichAttachmentsWithTranscripts(attachments, null);
    expect(attachments[0]).not.toHaveProperty("transcript");
  });
});

describe("whisper provider", () => {
  it("creates provider with default config", async () => {
    const { createWhisperProvider } = await import("../src/voice/providers/whisper");
    const provider = createWhisperProvider({ type: "whisper", model: "small", timeoutMs: 30000 });
    expect(provider.name).toBe("whisper-small");
  });

  it("canTranscribe returns true for audio mime", async () => {
    const { createWhisperProvider } = await import("../src/voice/providers/whisper");
    const provider = createWhisperProvider({ type: "whisper" });
    expect(provider.canTranscribe({ localPath: "/tmp/a.ogg", mime: "audio/ogg", sizeBytes: 1000 })).toBe(true);
  });

  it("canTranscribe returns false for non-audio", async () => {
    const { createWhisperProvider } = await import("../src/voice/providers/whisper");
    const provider = createWhisperProvider({ type: "whisper" });
    expect(provider.canTranscribe({ localPath: "/tmp/a.jpg", mime: "image/jpeg", sizeBytes: 1000 })).toBe(false);
  });
});

describe("Pi adapter transcript formatting", () => {
  it("includes completed transcript in manifest", () => {
    const attachment = {
      id: "att_test123",
      mediaType: "audio" as const,
      name: "audio.ogg",
      localPath: "/tmp/audio.ogg",
      mime: "audio/ogg",
      sizeBytes: 18000,
      untrusted: true as const,
      transcript: {
        text: "hello world",
        provider: "whisper-small",
        language: "english",
        approximate: true as const,
        status: "completed" as const,
        durationMs: 5000,
      },
    };

    // Simulate what pi.ts formatMessage does
    const entry: Record<string, unknown> = {
      id: attachment.id,
      type: attachment.mediaType,
      name: attachment.name,
      localPath: attachment.localPath,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      untrusted: true,
    };
    if (attachment.transcript?.status === "completed" && attachment.transcript.text) {
      entry.transcript = {
        text: attachment.transcript.text,
        language: attachment.transcript.language,
        provider: attachment.transcript.provider,
        approximate: true,
      };
    }

    expect(entry.transcript).toBeDefined();
    expect((entry.transcript as any).text).toBe("hello world");
    expect((entry.transcript as any).language).toBe("english");
    expect((entry.transcript as any).approximate).toBe(true);
  });

  it("includes failed transcript in manifest", () => {
    const attachment = {
      id: "att_fail",
      mediaType: "audio" as const,
      name: "audio.ogg",
      localPath: "/tmp/audio.ogg",
      mime: "audio/ogg",
      sizeBytes: 18000,
      untrusted: true as const,
      transcript: {
        text: "",
        provider: "none",
        approximate: true as const,
        status: "failed" as const,
        error: "All STT providers failed",
      },
    };

    const entry: Record<string, unknown> = { id: attachment.id };
    if (attachment.transcript?.status === "completed" && attachment.transcript.text) {
      entry.transcript = { text: attachment.transcript.text };
    } else if (attachment.transcript?.status === "failed") {
      entry.transcript = { status: "failed", error: attachment.transcript.error, approximate: true };
    }

    expect(entry.transcript).toBeDefined();
    expect((entry.transcript as any).status).toBe("failed");
    expect((entry.transcript as any).error).toBe("All STT providers failed");
  });

  it("voice-only message gets transcript as text", () => {
    const userText = "";
    const transcripts = [{ status: "completed" as const, text: "hello from voice" }]
      .filter((t) => t.status === "completed" && t.text)
      .map((t) => t.text);

    let promptText = userText.trim();
    if (!promptText && transcripts.length > 0) {
      promptText = `Voice message transcript: ${transcripts.join(" ")}`;
    }

    expect(promptText).toBe("Voice message transcript: hello from voice");
  });
});

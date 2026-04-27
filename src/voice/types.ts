/**
 * voice/types.ts — Shared types for voice STT/TTS
 */

// ── STT (Speech-to-Text) ────────────────────────────

export interface SttProvider {
  readonly name: string;
  canTranscribe(input: SttInput): boolean;
  transcribe(input: SttInput): Promise<TranscriptionResult>;
}

export interface SttInput {
  localPath: string;
  mime: string;
  sizeBytes: number;
  hint?: {
    language?: string;
    isVoiceMessage?: boolean;
  };
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  confidence?: number;
  approximate: true;
}

// ── Attachment transcript (stored on MessageAttachment) ──

export interface AttachmentTranscript {
  text: string;
  provider: string;
  language?: string;
  confidence?: number;
  approximate: true;
  status: "completed" | "failed";
  error?: string;
  durationMs?: number;
}

// ── STT config ───────────────────────────────────────

export interface SttProviderConfig {
  type: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface SttConfig {
  enabled: boolean;
  mode: "on" | "off";
  autoInstall?: boolean;
  chain: string[];
  autoTranscribe: {
    voiceMessages: boolean;
    audioFiles: boolean;
    maxDurationSec: number;
  };
  providers: Record<string, SttProviderConfig>;
}

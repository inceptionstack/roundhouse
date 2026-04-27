/**
 * voice/stt-service.ts — Speech-to-text service
 *
 * Manages provider chain, timeouts, and graceful fallback.
 * Never throws — returns null on all failures.
 */

import type { SttProvider, SttInput, SttConfig, AttachmentTranscript } from "./types";
import type { MessageAttachment } from "../types";
import { createWhisperProvider, type InstallableWhisperProvider } from "./providers/whisper";

// Provider factory registry
const PROVIDER_FACTORIES: Record<string, (config: any) => SttProvider> = {
  whisper: createWhisperProvider,
};

export class SttService {
  private providers: SttProvider[] = [];
  private config: SttConfig;
  private initPromise: Promise<void> | null = null;
  private activeStt: Promise<void> = Promise.resolve(); // global concurrency: 1 at a time
  private installNoticeSent = false;

  constructor(config: SttConfig) {
    this.config = config;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null; // retry on next call
        throw err;
      });
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    for (const providerName of this.config.chain) {
      const providerConfig = this.config.providers[providerName];
      if (!providerConfig) {
        console.warn(`[stt] provider "${providerName}" in chain but not configured, skipping`);
        continue;
      }

      const type = providerConfig.type;
      const factory = PROVIDER_FACTORIES[type];

      if (!factory) {
        console.warn(`[stt] unknown provider type "${type}", skipping`);
        continue;
      }

      try {
        // Pass autoInstall from service-level config into provider config
        const mergedProviderConfig = {
          ...providerConfig,
          autoInstall: this.config.autoInstall ?? providerConfig.autoInstall ?? true,
        };
        this.providers.push(factory(mergedProviderConfig));
        console.log(`[stt] loaded provider: ${providerName} (${type})`);
      } catch (err) {
        console.warn(`[stt] failed to create provider "${providerName}":`, (err as Error).message);
      }
    }

    if (this.providers.length === 0) {
      console.warn(`[stt] no providers available — transcription disabled`);
    }
  }

  /**
   * Prepare providers in background (install + warm model).
   * Called from gateway.start() — non-blocking, never throws.
   */
  async prepareInBackground(): Promise<void> {
    try {
      await this.ensureInitialized();
    } catch {
      return;
    }

    for (const provider of this.providers) {
      if ("ensureInstalled" in provider && typeof (provider as any).ensureInstalled === "function") {
        try {
          const installable = provider as InstallableWhisperProvider;
          const ok = await installable.ensureInstalled();
          if (ok) {
            console.log(`[stt] ${provider.name} ready (installed + model warmed)`);
          } else {
            console.warn(`[stt] ${provider.name} not available after prepare`);
          }
        } catch (err) {
          console.warn(`[stt] ${provider.name} prepare failed:`, (err as Error).message);
        }
      }
    }
  }

  /** Should this attachment be auto-transcribed? */
  shouldTranscribe(attachment: MessageAttachment): boolean {
    if (!this.config.enabled || this.config.mode === "off") return false;

    const auto = this.config.autoTranscribe ?? { voiceMessages: true, audioFiles: false, maxDurationSec: 120 };

    // Only audio
    if (attachment.mediaType !== "audio") return false;
    if (!attachment.mime.startsWith("audio/")) return false;

    // Voice messages (ogg/opus from Telegram) vs general audio files
    const isVoiceMessage = attachment.mime === "audio/ogg" && attachment.name.endsWith(".ogg");
    if (isVoiceMessage && auto.voiceMessages) return true;
    if (!isVoiceMessage && auto.audioFiles) return true;

    return false;
  }

  /**
   * Try to transcribe an attachment using the provider chain.
   * Returns null on all failures — never throws to callers.
   */
  async tryTranscribe(
    attachment: MessageAttachment,
    languageHint?: string,
    notify?: (text: string) => Promise<void>,
  ): Promise<AttachmentTranscript | null> {
    try {
      await this.ensureInitialized();
    } catch (err) {
      console.warn(`[stt] initialization failed:`, (err as Error).message);
      return null;
    }

    if (this.providers.length === 0) return null;
    if (!this.shouldTranscribe(attachment)) return null;

    // Check duration limit using ffprobe
    const maxDuration = this.config.autoTranscribe?.maxDurationSec ?? 120;
    if (maxDuration > 0) {
      try {
        const duration = await getAudioDuration(attachment.localPath);
        if (duration !== null && duration > maxDuration) {
          console.log(`[stt] skipping ${attachment.name}: duration ${duration.toFixed(1)}s exceeds ${maxDuration}s limit`);
          return null;
        }
      } catch {}
    }

    const input: SttInput = {
      localPath: attachment.localPath,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      hint: {
        language: languageHint,
        isVoiceMessage: attachment.mime === "audio/ogg",
      },
    };

    const startTime = Date.now();

    // Global concurrency limit: one transcription at a time to prevent CPU stampede
    // Promise executor runs synchronously per spec, so release is always assigned before await
    const prev = this.activeStt;
    let release: () => void;
    this.activeStt = new Promise<void>((r) => { release = r; });
    await prev;

    try {
      for (const provider of this.providers) {
        if (!provider.canTranscribe(input)) continue;

        // Send one-time install notice if provider needs to install
        if (!this.installNoticeSent && notify) {
          const installable = provider as InstallableWhisperProvider;
          if (installable.ensureInstalled) {
            // Check if install is actually needed (binary not found)
            try {
              this.installNoticeSent = true;
              const isReady = await installable.ensureInstalled();
              if (!isReady) {
                await notify("🎤 Voice transcription not available. Install whisper: `pip3 install --user openai-whisper`");
                continue;
              }
            } catch {
              continue;
            }
          }
        }

        try {
          console.log(`[stt] trying ${provider.name} for ${attachment.name}...`);
          const result = await provider.transcribe(input);
          const durationMs = Date.now() - startTime;

          console.log(`[stt] ${provider.name} succeeded in ${durationMs}ms: "${result.text.slice(0, 80)}"`);

          return {
            text: result.text,
            provider: provider.name,
            language: result.language,
            confidence: result.confidence,
            approximate: true,
            status: "completed" as const,
            durationMs,
          };
        } catch (err) {
          console.warn(`[stt] ${provider.name} failed:`, (err as Error).message);
          continue;
        }
      }

      // All providers failed
      return {
        text: "",
        provider: "none",
        approximate: true,
        status: "failed" as const,
        error: "All STT providers failed",
        durationMs: Date.now() - startTime,
      };
    } finally {
      release!();
    }
  }
}

/**
 * Enrich audio attachments with transcripts.
 * Mutates the attachments array in-place.
 */
export async function enrichAttachmentsWithTranscripts(
  attachments: MessageAttachment[],
  sttService: SttService | null,
  notify?: (text: string) => Promise<void>,
): Promise<void> {
  if (!sttService) return;

  for (const att of attachments) {
    try {
      const transcript = await sttService.tryTranscribe(att, undefined, notify);
      if (transcript) {
        att.transcript = transcript;
      }
    } catch (err) {
      console.error(`[stt] unexpected error transcribing ${att.name}:`, (err as Error).message);
    }
  }
}

/** Get audio duration using ffprobe. Returns null if ffprobe is unavailable. */
async function getAudioDuration(filePath: string): Promise<number | null> {
  const { execFile: exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(
      "ffprobe",
      ["-i", filePath, "-show_entries", "format=duration", "-v", "quiet", "-of", "csv=p=0"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? null : dur);
      },
    );
  });
}

/** Default STT config */
export const DEFAULT_STT_CONFIG: SttConfig = {
  enabled: false,
  mode: "on",
  autoInstall: true,
  chain: ["whisper"],
  autoTranscribe: {
    voiceMessages: true,
    audioFiles: false,
    maxDurationSec: 120,
  },
  providers: {
    whisper: {
      type: "whisper",
      model: "small",
      timeoutMs: 30000,
    },
  },
};

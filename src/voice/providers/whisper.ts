/**
 * voice/providers/whisper.ts — Local Whisper STT provider
 *
 * Runs the whisper CLI via child_process. Auto-detects language.
 * Reports missing dependencies so the agent can install them.
 */

import { execFile } from "node:child_process";
import { access, constants, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { SttProvider, SttInput, TranscriptionResult, SttProviderConfig } from "../types";

// ── Binary discovery ─────────────────────────────────

const WHISPER_PATHS = [
  join(homedir(), ".local", "bin", "whisper"),
  "/usr/local/bin/whisper",
  "/usr/bin/whisper",
];

const FFMPEG_PATHS = [
  join(homedir(), ".local", "bin", "ffmpeg"),
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

let cachedBinaryPath: string | null | undefined; // undefined = not checked yet

async function findWhisperBinary(): Promise<string | null> {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  for (const p of WHISPER_PATHS) {
    try {
      await access(p, constants.X_OK);
      cachedBinaryPath = p;
      return p;
    } catch {}
  }
  // Don't cache null — allows detection after agent installs whisper
  return null;
}

async function findFfmpeg(): Promise<string | null> {
  for (const p of FFMPEG_PATHS) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}


// ── Model warmup ─────────────────────────────────────

/**
 * Warm the whisper model by running a tiny transcription.
 * This forces the model download (~461MB for small).
 */
async function warmWhisperModel(binary: string, model: string): Promise<boolean> {
  const warmupDir = join(homedir(), ".roundhouse", "whisper-warmup", randomBytes(4).toString("hex"));
  mkdirSync(warmupDir, { recursive: true });

  // Generate a tiny silent WAV file (1 second, 16kHz, mono, 16-bit)
  const sampleRate = 16000;
  const numSamples = sampleRate; // 1 second
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buf = Buffer.alloc(44 + dataSize);
  // WAV header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM format chunk size
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(1, 22);  // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);  // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // Data is all zeros (silence)

  const wavPath = join(warmupDir, "silence.wav");
  await writeFile(wavPath, buf);

  console.log(`[stt/whisper] warming model '${model}' (may download ~461MB)...`);

  return new Promise<boolean>((resolve) => {
    execFile(
      binary,
      [wavPath, "--model", model, "--output_format", "json", "--output_dir", warmupDir],
      {
        timeout: 600_000, // 10 min for model download + first run
        env: {
          ...process.env,
          PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH}`,
        },
      },
      async (err) => {
        // Clean up warmup files
        try { await rm(warmupDir, { recursive: true }); } catch {}

        if (err) {
          console.warn(`[stt/whisper] model warmup failed: ${err.message}`);
          resolve(false);
        } else {
          console.log(`[stt/whisper] model '${model}' ready`);
          resolve(true);
        }
      },
    );
  });
}

// ── Provider ─────────────────────────────────────────

/** Extended provider that reports missing dependencies */
export interface InstallableWhisperProvider extends SttProvider {
  ensureInstalled(): Promise<boolean>;
  getMissingDeps(): Promise<string[]>;
}

export function createWhisperProvider(config: SttProviderConfig): InstallableWhisperProvider {
  const model = (config.model as string) ?? "small";
  const timeoutMs = config.timeoutMs ?? 30000;
  let modelWarmed = false;
  let warmFailed = false; // sticky failure to prevent warmup retry spam
  let warmPromise: Promise<boolean> | null = null;

  const WHISPER_LANGS = new Set(["af","am","ar","as","az","ba","be","bg","bn","bo","br","bs","ca","cs","cy","da","de","el","en","es","et","eu","fa","fi","fo","fr","gl","gu","ha","haw","he","hi","hr","ht","hu","hy","id","is","it","ja","jw","ka","kk","km","kn","ko","la","lb","ln","lo","lt","lv","mg","mi","mk","ml","mn","mr","ms","mt","my","ne","nl","nn","no","oc","pa","pl","ps","pt","ro","ru","sa","sd","si","sk","sl","sn","so","sq","sr","su","sv","sw","ta","te","tg","th","tk","tl","tr","tt","uk","ur","uz","vi","yi","yo","yue","zh"]);

  async function getBinary(): Promise<string | null> {
    const existing = await findWhisperBinary();
    if (!existing) return null;

    // Also need ffmpeg
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) return null;

    return existing;
  }

  return {
    name: `whisper-${model}`,

    canTranscribe(input: SttInput): boolean {
      return input.mime.startsWith("audio/");
    },

    async getMissingDeps(): Promise<string[]> {
      const missing: string[] = [];
      const whisper = await findWhisperBinary();
      if (!whisper) missing.push("whisper");
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) missing.push("ffmpeg");
      return missing;
    },

    async ensureInstalled(): Promise<boolean> {
      const binary = await getBinary();
      if (!binary) return false;

      // Warm model with singleton promise
      if (!modelWarmed && !warmFailed) {
        if (!warmPromise) {
          warmPromise = (async () => {
            // Check if model already cached
            const modelDir = join(homedir(), ".cache", "whisper");
            try {
              const files = await readdir(modelDir);
              if (files.some((f) => f.startsWith(model) && f.includes("."))) {
                modelWarmed = true;
                return true;
              }
            } catch {}

            // Run warmup
            try {
              const ok = await warmWhisperModel(binary, model);
              if (!ok) warmFailed = true;
              modelWarmed = ok;
              return ok;
            } catch (err) {
              console.warn(`[stt/whisper] warmup error: ${(err as Error).message}`);
              warmFailed = true;
              modelWarmed = false;
              return false;
            }
          })().finally(() => { warmPromise = null; });
        }
        await warmPromise;
      }
      return modelWarmed;
    },

    async transcribe(input: SttInput): Promise<TranscriptionResult> {
      const binary = await getBinary();
      if (!binary) {
        throw new Error("whisper or ffmpeg not available");
      }

      const outputDir = join(homedir(), ".roundhouse", "whisper-tmp", randomBytes(6).toString("hex"));
      mkdirSync(outputDir, { recursive: true });

      const audioPath = input.localPath.startsWith("-") ? `./${input.localPath}` : input.localPath;

      const args = [
        audioPath,
        "--model", model,
        "--output_format", "json",
        "--output_dir", outputDir,
      ];

      if (input.hint?.language && WHISPER_LANGS.has(input.hint.language)) {
        args.push("--language", input.hint.language);
      }

      return new Promise<TranscriptionResult>((resolve, reject) => {
        execFile(
          binary,
          args,
          {
            timeout: timeoutMs,
            env: {
              ...process.env,
              PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH}`,
            },
          },
          async (error, _stdout, stderr) => {
            const cleanup = async () => {
              try { await rm(outputDir, { recursive: true }); } catch {}
            };

            if (error) {
              await cleanup();
              reject(new Error(`whisper failed: ${error.message}`));
              return;
            }

            try {
              const files = await readdir(outputDir);
              const jsonFile = files.find((f) => f.endsWith(".json"));
              if (!jsonFile) {
                await cleanup();
                reject(new Error("whisper produced no JSON output"));
                return;
              }
              const raw = await readFile(join(outputDir, jsonFile), "utf8");
              const result = JSON.parse(raw);

              await cleanup();

              let language: string | undefined;
              const langMatch = stderr.match(/Detected language:\s*(\w+)/);
              if (langMatch) language = langMatch[1].toLowerCase();
              if (result.language) language = result.language;

              const text = (result.text ?? "").trim();
              if (!text) {
                reject(new Error("whisper returned empty transcript"));
                return;
              }

              // Mark model as warmed after successful transcription
              modelWarmed = true;

              resolve({ text, language, approximate: true });
            } catch (err) {
              await cleanup();
              reject(new Error(`whisper output parse failed: ${(err as Error).message}`));
            }
          },
        );
      });
    },
  };
}

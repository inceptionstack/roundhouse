/**
 * voice/providers/whisper.ts — Local Whisper STT provider
 *
 * Runs the whisper CLI via child_process. Auto-detects language.
 * Requires whisper to be installed: pip install openai-whisper
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { SttProvider, SttInput, TranscriptionResult, SttProviderConfig } from "../types";

// Possible whisper binary locations
const WHISPER_PATHS = [
  join(homedir(), ".local", "bin", "whisper"),
  "/usr/local/bin/whisper",
  "/usr/bin/whisper",
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
  cachedBinaryPath = null;
  return null;
}

export function createWhisperProvider(config: SttProviderConfig): SttProvider {
  const model = (config.model as string) ?? "small";
  const timeoutMs = config.timeoutMs ?? 30000;

  return {
    name: `whisper-${model}`,

    canTranscribe(input: SttInput): boolean {
      // Only transcribe audio files
      return input.mime.startsWith("audio/");
    },

    async transcribe(input: SttInput): Promise<TranscriptionResult> {
      const binary = await findWhisperBinary();
      if (!binary) {
        throw new Error("whisper binary not found");
      }

      const outputDir = join(homedir(), ".roundhouse", "whisper-tmp", randomBytes(6).toString("hex"));
      mkdirSync(outputDir, { recursive: true });

      // Ensure path doesn't start with dash (defence in depth — paths are always absolute)
      const audioPath = input.localPath.startsWith("-") ? `./${input.localPath}` : input.localPath;

      const args = [
        audioPath,
        "--model", model,
        "--output_format", "json",
        "--output_dir", outputDir,
      ];

      // Add language hint if provided (validate against whisper's known languages)
      const WHISPER_LANGS = new Set(["af","am","ar","as","az","ba","be","bg","bn","bo","br","bs","ca","cs","cy","da","de","el","en","es","et","eu","fa","fi","fo","fr","gl","gu","ha","haw","he","hi","hr","ht","hu","hy","id","is","it","ja","jw","ka","kk","km","kn","ko","la","lb","ln","lo","lt","lv","mg","mi","mk","ml","mn","mr","ms","mt","my","ne","nl","nn","no","oc","pa","pl","ps","pt","ro","ru","sa","sd","si","sk","sl","sn","so","sq","sr","su","sv","sw","ta","te","tg","th","tk","tl","tr","tt","uk","ur","uz","vi","yi","yo","yue","zh"]);
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
              try {
                const { rm } = await import("node:fs/promises");
                await rm(outputDir, { recursive: true });
              } catch {}
            };

            if (error) {
              await cleanup();
              reject(new Error(`whisper failed: ${error.message}`));
              return;
            }

            try {
              // Find the JSON output file (whisper names it based on input filename)
              const { readFile, readdir } = await import("node:fs/promises");
              const files = await readdir(outputDir);
              const jsonFile = files.find((f) => f.endsWith(".json"));
              if (!jsonFile) {
                await cleanup();
                reject(new Error("whisper produced no JSON output"));
                return;
              }
              const jsonPath = join(outputDir, jsonFile);
              const raw = await readFile(jsonPath, "utf8");
              const result = JSON.parse(raw);

              await cleanup();

              // Extract language from stderr (whisper prints "Detected language: X")
              let language: string | undefined;
              const langMatch = stderr.match(/Detected language:\s*(\w+)/);
              if (langMatch) {
                language = langMatch[1].toLowerCase();
              }
              if (result.language) {
                language = result.language;
              }

              const text = (result.text ?? "").trim();
              if (!text) {
                reject(new Error("whisper returned empty transcript"));
                return;
              }

              resolve({
                text,
                language,
                approximate: true,
              });
            } catch (err) {
              await cleanup();
              reject(new Error(`whisper output parse failed: ${(err as Error).message}`));
            }
          },
        );

        // execFile's built-in timeout handles killing the process
      });
    },
  };
}

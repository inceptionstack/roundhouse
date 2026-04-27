/**
 * STT / Voice checks
 */

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DoctorCheck } from "../types";

export const sttChecks: DoctorCheck[] = [
  {
    id: "whisper-model", category: "stt", name: "Whisper model cache",
    async run() {
      const modelDir = join(homedir(), ".cache", "whisper");
      try {
        const files = await readdir(modelDir);
        const models = files.filter((f) => f.endsWith(".pt"));
        if (models.length === 0) {
          return {
            id: "whisper-model", category: "stt", name: "Whisper model cache",
            status: "warn", summary: "no models downloaded",
            details: ["Model will download on first voice message (~461MB for small)"],
          };
        }
        return {
          id: "whisper-model", category: "stt", name: "Whisper model cache",
          status: "pass", summary: models.join(", "),
        };
      } catch {
        return {
          id: "whisper-model", category: "stt", name: "Whisper model cache",
          status: "info", summary: "cache dir not found",
          details: [`${modelDir} does not exist yet`],
        };
      }
    },
  },

  {
    id: "whisper-tmp", category: "stt", name: "Whisper temp dirs",
    async run() {
      const tmpDir = join(homedir(), ".roundhouse", "whisper-tmp");
      try {
        const entries = await readdir(tmpDir);
        if (entries.length === 0) {
          return { id: "whisper-tmp", category: "stt", name: "Whisper temp dirs", status: "pass", summary: "clean" };
        }
        return {
          id: "whisper-tmp", category: "stt", name: "Whisper temp dirs",
          status: "warn", summary: `${entries.length} orphaned dir(s)`,
          details: [`Leftover temp directories in ${tmpDir}`],
          fix: {
            description: "Clean orphaned temp dirs older than 1 hour",
            run: async () => {
              const { rm, stat: fsStat } = await import("node:fs/promises");
              const cutoff = Date.now() - 60 * 60 * 1000;
              let cleaned = 0;
              for (const entry of entries) {
                try {
                  const s = await fsStat(join(tmpDir, entry));
                  if (s.mtimeMs < cutoff) {
                    await rm(join(tmpDir, entry), { recursive: true });
                    cleaned++;
                  }
                } catch {}
              }
              return cleaned > 0;
            },
          },
        };
      } catch {
        return { id: "whisper-tmp", category: "stt", name: "Whisper temp dirs", status: "pass", summary: "no temp dir" };
      }
    },
  },
];

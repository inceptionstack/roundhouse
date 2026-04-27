/**
 * System requirement checks: Node, npm, pip3, ffmpeg, ffprobe, whisper
 */

import type { DoctorCheck, DoctorContext, DoctorCheckResult } from "../types";
import { which, getVersion, run } from "../shell";

function sysCheck(id: string, name: string, fn: (ctx: DoctorContext) => Promise<DoctorCheckResult>): DoctorCheck {
  return { id, category: "system", name, run: fn };
}

export const systemChecks: DoctorCheck[] = [
  sysCheck("node", "Node.js", async () => {
    const ver = await getVersion("node");
    if (!ver) return { id: "node", category: "system", name: "Node.js", status: "fail", summary: "not found on PATH" };
    const major = parseInt(ver.replace("v", ""));
    return {
      id: "node", category: "system", name: "Node.js", summary: ver,
      status: major >= 20 ? "pass" : "warn",
      details: major < 20 ? ["Node.js 20+ recommended"] : undefined,
    };
  }),

  sysCheck("npm", "npm", async () => {
    const ver = await getVersion("npm");
    return {
      id: "npm", category: "system", name: "npm", summary: ver ?? "not found",
      status: ver ? "pass" : "fail",
    };
  }),

  sysCheck("pip3", "pip3", async () => {
    const ver = await getVersion("pip3");
    return {
      id: "pip3", category: "system", name: "pip3", summary: ver ? ver.split(" ")[1] ?? ver : "not found",
      status: ver ? "pass" : "warn",
      details: !ver ? ["Needed for whisper STT auto-install"] : undefined,
    };
  }),

  sysCheck("ffmpeg", "ffmpeg", async (ctx) => {
    const path = await which("ffmpeg");
    if (path) {
      const ver = await run("ffmpeg", ["-version"]);
      const v = ver?.split("\n")[0]?.match(/version\s+([\S]+)/)?.[1] ?? "unknown";
      return { id: "ffmpeg", category: "system", name: "ffmpeg", status: "pass", summary: v };
    }
    return {
      id: "ffmpeg", category: "system", name: "ffmpeg", status: "warn", summary: "not found",
      details: ["Needed for voice audio conversion"],
      fix: { description: "Install ffmpeg", command: "sudo dnf install -y ffmpeg || sudo apt-get install -y ffmpeg" },
    };
  }),

  sysCheck("ffprobe", "ffprobe", async () => {
    const path = await which("ffprobe");
    return {
      id: "ffprobe", category: "system", name: "ffprobe", summary: path ? "available" : "not found",
      status: path ? "pass" : "warn",
      details: !path ? ["Needed for audio duration checks"] : undefined,
    };
  }),

  sysCheck("whisper", "whisper", async (ctx) => {
    // Check same paths as the whisper provider
    const { access: acc, constants: c } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    const { homedir: h } = await import("node:os");
    const paths = [j(h(), ".local", "bin", "whisper"), "/usr/local/bin/whisper", "/usr/bin/whisper"];
    for (const p of paths) {
      try { await acc(p, c.X_OK); return { id: "whisper", category: "system", name: "whisper", status: "pass", summary: p }; } catch {}
    }
    return {
      id: "whisper", category: "system", name: "whisper", status: "warn", summary: "not found",
      details: ["Needed for voice message transcription"],
      fix: {
        description: "Install whisper",
        command: "pip3 install --user openai-whisper",
        run: async () => {
          const result = await run("pip3", ["install", "--user", "openai-whisper"], 300000);
          return result !== null;
        },
      },
    };
  }),
];

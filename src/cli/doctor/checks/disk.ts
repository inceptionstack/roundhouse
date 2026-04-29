/**
 * Disk and directory checks
 */

import { access, readdir, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { DoctorCheck } from "../types";
import { run } from "../shell";
import { SESSIONS_DIR } from "../../../config";

const INCOMING_DIR = process.env.ROUNDHOUSE_INCOMING_DIR ?? join(homedir(), ".roundhouse", "incoming");

export const diskChecks: DoctorCheck[] = [
  {
    id: "incoming-dir", category: "disk", name: "Incoming directory",
    async run(ctx) {
      try {
        await access(INCOMING_DIR, constants.W_OK);
        return { id: "incoming-dir", category: "disk", name: "Incoming directory", status: "pass", summary: INCOMING_DIR };
      } catch {
        return {
          id: "incoming-dir", category: "disk", name: "Incoming directory",
          status: "warn", summary: "missing or not writable",
          details: [INCOMING_DIR],
          fix: {
            description: "Create incoming directory",
            run: async () => { mkdirSync(INCOMING_DIR, { recursive: true }); return true; },
          },
        };
      }
    },
  },

  {
    id: "sessions-dir", category: "disk", name: "Sessions directory",
    async run() {
      try {
        await access(SESSIONS_DIR);
        const threads = await readdir(SESSIONS_DIR);
        return {
          id: "sessions-dir", category: "disk", name: "Sessions directory",
          status: "pass", summary: `${threads.length} thread(s)`,
        };
      } catch {
        return {
          id: "sessions-dir", category: "disk", name: "Sessions directory",
          status: "info", summary: "not created yet (first message will create it)",
        };
      }
    },
  },

  {
    id: "disk-space", category: "disk", name: "Free disk space",
    async run() {
      const df = await run("df", ["-BM", "--output=avail", homedir()]);
      if (!df) return { id: "disk-space", category: "disk", name: "Free disk space", status: "info", summary: "cannot check" };
      const lines = df.split("\n").filter(Boolean);
      const avail = parseInt(lines[lines.length - 1]);
      if (isNaN(avail)) return { id: "disk-space", category: "disk", name: "Free disk space", status: "info", summary: "cannot parse" };
      const gb = (avail / 1024).toFixed(1);
      if (avail < 100) return { id: "disk-space", category: "disk", name: "Free disk space", status: "fail", summary: `${gb} GB`, details: ["Less than 100 MB free"] };
      if (avail < 1024) return { id: "disk-space", category: "disk", name: "Free disk space", status: "warn", summary: `${gb} GB`, details: ["Less than 1 GB free"] };
      return { id: "disk-space", category: "disk", name: "Free disk space", status: "pass", summary: `${gb} GB` };
    },
  },
];

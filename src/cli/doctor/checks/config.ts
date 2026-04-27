/**
 * Configuration checks
 */

import { readFile, access, mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import type { DoctorCheck, DoctorContext, DoctorCheckResult } from "../types";
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_CONFIG } from "../../../config";

export const configChecks: DoctorCheck[] = [
  {
    id: "config-dir", category: "config", name: "Config directory",
    async run(ctx) {
      try {
        await access(CONFIG_DIR);
        return { id: "config-dir", category: "config", name: "Config directory", status: "pass", summary: CONFIG_DIR };
      } catch {
        return {
          id: "config-dir", category: "config", name: "Config directory", status: "warn", summary: "missing",
          details: [`${CONFIG_DIR} does not exist`],
          fix: {
            description: "Create config directory",
            command: `mkdir -p ${CONFIG_DIR}`,
            run: async () => { await mkdir(CONFIG_DIR, { recursive: true }); return true; },
          },
        };
      }
    },
  },

  {
    id: "config-file", category: "config", name: "Config file",
    async run(ctx) {
      try {
        const raw = await readFile(CONFIG_PATH, "utf8");
        try {
          JSON.parse(raw);
          return { id: "config-file", category: "config", name: "Config file", status: "pass", summary: CONFIG_PATH };
        } catch {
          return { id: "config-file", category: "config", name: "Config file", status: "fail", summary: "invalid JSON", details: [`${CONFIG_PATH} is not valid JSON`] };
        }
      } catch {
        return {
          id: "config-file", category: "config", name: "Config file", status: "warn", summary: "not found (defaults will be used)",
          details: [`${CONFIG_PATH} does not exist`],
          fix: {
            description: "Create default config",
            command: `roundhouse install`,
            run: async () => {
              await mkdir(CONFIG_DIR, { recursive: true });
              await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
              return true;
            },
          },
        };
      }
    },
  },

  {
    id: "config-schema", category: "config", name: "Config schema",
    async run(ctx) {
      try {
        const raw = await readFile(CONFIG_PATH, "utf8");
        const cfg = JSON.parse(raw);
        const issues: string[] = [];
        if (!cfg.agent?.type) issues.push("Missing agent.type");
        if (!cfg.chat?.botUsername) issues.push("Missing chat.botUsername");
        if (!cfg.chat?.adapters || Object.keys(cfg.chat.adapters).length === 0) issues.push("No chat adapters configured");
        if (!cfg.chat?.allowedUsers?.length) issues.push("allowedUsers is empty (anyone can message the bot)");

        if (issues.length === 0) {
          return { id: "config-schema", category: "config", name: "Config schema", status: "pass", summary: "valid" };
        }
        const hasError = issues.some((i) => i.startsWith("Missing"));
        return {
          id: "config-schema", category: "config", name: "Config schema",
          status: hasError ? "fail" : "warn", summary: `${issues.length} issue(s)`, details: issues,
        };
      } catch {
        return { id: "config-schema", category: "config", name: "Config schema", status: "info", summary: "skipped (no config file)" };
      }
    },
  },
];

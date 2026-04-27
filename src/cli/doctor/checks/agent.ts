/**
 * Agent checks (pi-specific)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DoctorCheck } from "../types";
import { which } from "../shell";

export const agentChecks: DoctorCheck[] = [
  {
    id: "pi-sdk", category: "agent", name: "Pi SDK",
    async run() {
      const PI_PKG = join("@mariozechner", "pi-coding-agent", "package.json");
      const searchPaths = [
        join(process.cwd(), "node_modules", PI_PKG),
      ];
      // Also check global npm root
      try {
        const { execFileSync } = await import("node:child_process");
        const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
        searchPaths.push(join(globalRoot, PI_PKG));
      } catch {}
      for (const pkgPath of searchPaths) {
        try {
          const raw = await readFile(pkgPath, "utf8");
          const ver = JSON.parse(raw).version;
          return { id: "pi-sdk", category: "agent", name: "Pi SDK", status: "pass" as const, summary: `v${ver}` };
        } catch {}
      }
      return {
          id: "pi-sdk", category: "agent", name: "Pi SDK", status: "fail" as const, summary: "not found",
          details: ["@mariozechner/pi-coding-agent not installed"],
          fix: { description: "Install pi SDK", command: "npm install @mariozechner/pi-coding-agent" },
        };
    },
  },

  {
    id: "pi-cli", category: "agent", name: "Pi CLI",
    async run() {
      const path = await which("pi");
      return {
        id: "pi-cli", category: "agent", name: "Pi CLI",
        status: path ? "pass" : "warn", summary: path ?? "not found",
        details: !path ? ["pi CLI needed for roundhouse tui"] : undefined,
      };
    },
  },

  {
    id: "pi-settings", category: "agent", name: "Pi settings",
    async run() {
      const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
      try {
        const raw = await readFile(settingsPath, "utf8");
        const settings = JSON.parse(raw);
        const model = settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "not configured";
        const issues: string[] = [];
        if (!settings.defaultProvider) issues.push("No defaultProvider set");
        if (!settings.defaultModel) issues.push("No defaultModel set");
        return {
          id: "pi-settings", category: "agent", name: "Pi settings",
          status: issues.length ? "warn" : "pass",
          summary: issues.length ? `${issues.length} issue(s)` : `model: ${model}`,
          details: issues.length ? issues : undefined,
        };
      } catch {
        return {
          id: "pi-settings", category: "agent", name: "Pi settings",
          status: "warn", summary: "not found",
          details: [`${settingsPath} does not exist`],
        };
      }
    },
  },
];

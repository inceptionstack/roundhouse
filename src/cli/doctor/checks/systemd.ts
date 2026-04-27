/**
 * Systemd service checks
 */

import type { DoctorCheck } from "../types";
import { run, runLoose } from "../shell";

/** Redact known secret patterns from log lines */
function redactSecrets(line: string): string {
  return line
    .replace(/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:TOKEN]")
    .replace(/\b(sk-|pk-|key-)[A-Za-z0-9]{20,}\b/g, "[REDACTED:KEY]");
}

export const systemdChecks: DoctorCheck[] = [
  {
    id: "systemd-unit", category: "systemd", name: "Service unit",
    async run(ctx) {
      const result = await run("systemctl", ["cat", ctx.serviceName]);
      return {
        id: "systemd-unit", category: "systemd", name: "Service unit",
        status: result ? "pass" : "warn",
        summary: result ? "installed" : "not installed",
        details: !result ? ["Run: roundhouse install"] : undefined,
      };
    },
  },

  {
    id: "systemd-active", category: "systemd", name: "Service status",
    async run(ctx) {
      // Use runLoose because systemctl exits non-zero for inactive/failed
      const active = await runLoose("systemctl", ["is-active", ctx.serviceName]);
      if (active === "active") {
        return { id: "systemd-active", category: "systemd", name: "Service status", status: "pass", summary: "active" };
      }
      if (active === "inactive" || active === "failed") {
        const enabled = await runLoose("systemctl", ["is-enabled", ctx.serviceName]);
        return {
          id: "systemd-active", category: "systemd", name: "Service status",
          status: "warn", summary: active,
          details: [
            active === "failed" ? "Service has failed. Check: roundhouse logs" : "Service is stopped.",
            ...(enabled === "disabled" ? ["Service is disabled. Run: sudo systemctl enable roundhouse"] : []),
          ],
        };
      }
      // null = systemctl not available or service not found
      return {
        id: "systemd-active", category: "systemd", name: "Service status",
        status: "info", summary: "not installed or systemctl unavailable",
      };
    },
  },

  {
    id: "systemd-errors", category: "systemd", name: "Recent errors",
    async run(ctx) {
      const logs = await run("journalctl", ["-u", ctx.serviceName, "--since", "1 hour ago", "--no-pager", "-p", "err", "-q"]);
      if (logs === null) {
        return { id: "systemd-errors", category: "systemd", name: "Recent errors", status: "info", summary: "cannot read journal" };
      }
      const lines = logs.split("\n").filter(Boolean);
      if (lines.length === 0) {
        return { id: "systemd-errors", category: "systemd", name: "Recent errors", status: "pass", summary: "none in last hour" };
      }
      return {
        id: "systemd-errors", category: "systemd", name: "Recent errors",
        status: "warn", summary: `${lines.length} error(s) in last hour`,
        details: lines.slice(0, 5).map(redactSecrets),
      };
    },
  },
];

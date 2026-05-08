/**
 * cli/service-manager.ts — Platform-specific service lifecycle management
 *
 * Abstracts the difference between macOS (launchd) and Linux (systemd)
 * behind a single interface. CLI commands delegate to getServiceManager()
 * instead of branching on process.platform in every function.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { SERVICE_NAME } from "../config";

// ── Interface ────────────────────────────────────────

export interface ServiceStatus {
  running: boolean;
  installed: boolean;
  message: string;
}

export interface ServiceManager {
  /** Start the service (load agent / start daemon) */
  start(): Promise<{ started: boolean; message: string }>;
  /** Stop the service */
  stop(): Promise<{ message: string }>;
  /** Restart the service (stop + start) */
  restart(): Promise<{ message: string }>;
  /** Get current service status */
  status(): Promise<ServiceStatus>;
  /** Tail logs (spawns a child process, returns it) */
  logs(): void;
  /** Uninstall the service (remove plist / unit file) */
  uninstall(): Promise<{ message: string }>;
}

// ── LaunchdManager (macOS) ───────────────────────────

class LaunchdManager implements ServiceManager {
  private get plistPath(): string {
    return resolve(homedir(), "Library", "LaunchAgents", "com.inceptionstack.roundhouse.plist");
  }

  private get label(): string {
    return "com.inceptionstack.roundhouse";
  }

  private isInstalled(): boolean {
    const { existsSync } = require("node:fs");
    return existsSync(this.plistPath);
  }

  private isRunning(): boolean {
    try {
      const output = execFileSync("launchctl", ["list", this.label], { encoding: "utf8", stdio: "pipe" });
      return output.includes(this.label);
    } catch {
      return false;
    }
  }

  async start(): Promise<{ started: boolean; message: string }> {
    if (!this.isInstalled()) {
      return { started: false, message: "No LaunchAgent installed. Run: roundhouse setup --telegram" };
    }
    if (this.isRunning()) {
      return { started: false, message: "Roundhouse is already running (LaunchAgent)." };
    }
    try {
      execFileSync("launchctl", ["load", this.plistPath], { stdio: "pipe" });
      return { started: true, message: "LaunchAgent started." };
    } catch {
      return { started: false, message: "Failed to load LaunchAgent." };
    }
  }

  async stop(): Promise<{ message: string }> {
    if (!this.isInstalled()) {
      return { message: "No LaunchAgent installed. Nothing to stop." };
    }
    try {
      execFileSync("launchctl", ["unload", this.plistPath], { stdio: "pipe" });
    } catch (e: any) {
      if (!e.message?.includes("Could not find")) {
        return { message: `(unload warning: ${e.message?.split("\n")[0]})` };
      }
    }
    return { message: "LaunchAgent stopped." };
  }

  async restart(): Promise<{ message: string }> {
    if (!this.isInstalled()) {
      return { message: "No LaunchAgent installed. Run: roundhouse setup --telegram" };
    }
    try { execFileSync("launchctl", ["unload", this.plistPath], { stdio: "pipe" }); } catch {}
    execFileSync("launchctl", ["load", this.plistPath], { stdio: "pipe" });
    return { message: "LaunchAgent restarted." };
  }

  async status(): Promise<ServiceStatus> {
    if (this.isRunning()) {
      return { running: true, installed: true, message: "Roundhouse is running (LaunchAgent)." };
    }
    if (this.isInstalled()) {
      return { running: false, installed: true, message: "LaunchAgent installed but not running." };
    }
    return { running: false, installed: false, message: "Roundhouse is not running." };
  }

  logs(): void {
    const logPath = resolve(homedir(), ".roundhouse", "logs", "roundhouse.log");
    const child = spawn("tail", ["-f", "-n", "100", logPath], { stdio: "inherit" });
    child.on("error", () => console.log("Could not read logs. Check ~/.roundhouse/logs/"));
  }

  async uninstall(): Promise<{ message: string }> {
    if (!this.isInstalled()) {
      return { message: "No LaunchAgent installed." };
    }
    try { execFileSync("launchctl", ["unload", this.plistPath], { stdio: "pipe" }); } catch {}
    const { unlink } = await import("node:fs/promises");
    try { await unlink(this.plistPath); } catch {}
    return { message: "LaunchAgent removed." };
  }
}

// ── SystemdManager (Linux) ───────────────────────────

class SystemdManager implements ServiceManager {
  async start(): Promise<{ started: boolean; message: string }> {
    const { isServiceInstalled, isServiceActive, systemctl } = await import("./systemd");
    if (!isServiceInstalled()) {
      return { started: false, message: "no-service" }; // Signal to caller: fall through to foreground
    }
    if (isServiceActive()) {
      return { started: false, message: "Roundhouse is already running." };
    }
    systemctl("start", "Daemon started.");
    return { started: true, message: "Daemon started." };
  }

  async stop(): Promise<{ message: string }> {
    const { systemctl } = await import("./systemd");
    systemctl("stop", "Daemon stopped.");
    return { message: "Daemon stopped." };
  }

  async restart(): Promise<{ message: string }> {
    const { systemctl } = await import("./systemd");
    systemctl("restart", "Daemon restarted.");
    return { message: "Daemon restarted." };
  }

  async status(): Promise<ServiceStatus> {
    const { isServiceActive, isServiceInstalled } = await import("./systemd");
    if (isServiceActive()) {
      return { running: true, installed: true, message: "Roundhouse is running." };
    }
    if (isServiceInstalled()) {
      return { running: false, installed: true, message: "Service installed but not running." };
    }
    return { running: false, installed: false, message: "Roundhouse is not running." };
  }

  logs(): void {
    const child = spawn("journalctl", ["-u", SERVICE_NAME, "-f", "--no-pager", "-n", "100"], {
      stdio: "inherit",
    });
    child.on("error", () => console.log("Could not read logs. Is the daemon installed?"));
  }

  async uninstall(): Promise<{ message: string }> {
    const { systemctl, runSudo, SERVICE_PATH } = await import("./systemd");
    try { systemctl("stop"); } catch {}
    try { systemctl("disable"); } catch {}
    try { runSudo("rm", "-f", SERVICE_PATH); } catch {}
    runSudo("systemctl", "daemon-reload");
    return { message: "Daemon removed." };
  }
}

// ── Factory ──────────────────────────────────────────

/**
 * Get the appropriate service manager for the current platform.
 */
export function getServiceManager(): ServiceManager {
  if (process.platform === "darwin") {
    return new LaunchdManager();
  }
  return new SystemdManager();
}

/**
 * launchd.ts — macOS launchd service management for roundhouse
 *
 * Generates and installs a LaunchAgent plist so roundhouse
 * auto-starts on login and can be managed via launchctl.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { whichSync } from "./systemd";
import { ROUNDHOUSE_DIR } from "../config";

const LABEL = "com.inceptionstack.roundhouse";
const PLIST_DIR = resolve(homedir(), "Library", "LaunchAgents");
export const PLIST_PATH = resolve(PLIST_DIR, `${LABEL}.plist`);

export interface LaunchdOptions {
  envFilePath?: string;
}

/**
 * Generate a LaunchAgent plist for roundhouse.
 */
export function generatePlist(opts: LaunchdOptions = {}): string {
  const nodeBin = whichSync("node") || process.execPath;
  const roundhouseBin = whichSync("roundhouse");

  let programArgs: string[];
  if (roundhouseBin) {
    programArgs = [nodeBin, roundhouseBin, "run"];
  } else {
    // Fallback: tsx path
    const tsxBin = whichSync("tsx") || resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");
    const cliPath = resolve(__dirname, "cli.ts");
    programArgs = [nodeBin, tsxBin, cliPath, "run"];
  }

  const logDir = resolve(ROUNDHOUSE_DIR, "logs");
  const envFile = opts.envFilePath || resolve(ROUNDHOUSE_DIR, ".env");

  // Build environment variables to include
  const envKeys = [
    "PATH",
    "HOME",
    "ROUNDHOUSE_CONFIG",
    "NODE_NO_WARNINGS",
  ];

  let envSection = "";
  const envVars: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    ROUNDHOUSE_CONFIG: resolve(ROUNDHOUSE_DIR, "gateway.config.json"),
    NODE_NO_WARNINGS: "1",
  };

  envSection = Object.entries(envVars)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs.map(a => `        <string>${escapeXml(a)}</string>`).join("\n")}
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envSection}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${escapeXml(resolve(logDir, "roundhouse.log"))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(resolve(logDir, "roundhouse.err"))}</string>

    <key>WorkingDirectory</key>
    <string>${escapeXml(homedir())}</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`;
}

/**
 * Install the plist and load the service.
 */
export async function installLaunchAgent(opts: LaunchdOptions = {}): Promise<void> {
  await mkdir(PLIST_DIR, { recursive: true });
  await mkdir(resolve(ROUNDHOUSE_DIR, "logs"), { recursive: true });

  const plist = generatePlist(opts);
  await writeFile(PLIST_PATH, plist, { mode: 0o644 });

  // Unload first if already loaded (ignore errors)
  try {
    execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
  } catch {}

  // Load the agent
  execFileSync("launchctl", ["load", PLIST_PATH], { stdio: "pipe" });
}

/**
 * Unload and remove the launch agent.
 */
export async function uninstallLaunchAgent(): Promise<void> {
  try {
    execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
  } catch {}

  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(PLIST_PATH);
  } catch {}
}

/**
 * Check if the launch agent is loaded and running.
 */
export function isLaunchAgentRunning(): boolean {
  try {
    const output = execFileSync("launchctl", ["list", LABEL], { encoding: "utf8", stdio: "pipe" });
    return output.includes(LABEL);
  } catch {
    return false;
  }
}

/**
 * Check if the plist file exists.
 */
export function isLaunchAgentInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const __dirname = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

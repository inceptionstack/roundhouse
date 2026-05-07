/**
 * commands/update.ts — Handle the /update command
 *
 * Transport-agnostic: receives a ProgressReporter interface,
 * not a Telegram-specific thread object.
 */

import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { provisionBundle } from "../bundle";

export interface UpdateProgress {
  update(text: string): Promise<void>;
}

export interface UpdateResult {
  action: "already-latest" | "updated";
  currentVersion: string;
  latestVersion?: string;
}

/**
 * Check for updates, install if newer, provision bundle, patch settings.
 * Returns the result — caller decides how to present it and whether to restart.
 */
export async function performUpdate(progress: UpdateProgress): Promise<UpdateResult> {
  // Get current version
  const pkg = await import("../../package.json", { with: { type: "json" } });
  const currentVersion = pkg.default?.version ?? "unknown";

  // Check latest version on npm
  const latestVersion = execSync("npm view @inceptionstack/roundhouse version 2>/dev/null", {
    timeout: 30_000,
    encoding: "utf8",
  }).trim();

  if (!latestVersion || latestVersion === currentVersion) {
    return { action: "already-latest", currentVersion };
  }

  await progress.update(`📦 Updating v${currentVersion} → v${latestVersion}...`);

  execSync("npm install -g @inceptionstack/roundhouse@latest 2>&1", {
    timeout: 120_000,
    encoding: "utf8",
  });

  // Provision bundle (skills sync + CLI tools + config)
  try {
    provisionBundle();
  } catch (e) {
    console.warn("[roundhouse] bundle provisioning failed:", e instanceof Error ? e.message : e);
  }

  // Ensure settings.json includes roundhouse package (for pre-bundle upgrades)
  try {
    const settingsPath = `${homedir()}/.pi/agent/settings.json`;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const selfPkg = "npm:@inceptionstack/roundhouse";
    if (!Array.isArray(settings.packages)) settings.packages = [];
    if (!settings.packages.includes(selfPkg)) {
      settings.packages.push(selfPkg);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
  } catch { /* settings.json may not exist yet — fine, setup will create it */ }

  return { action: "updated", currentVersion, latestVersion };
}

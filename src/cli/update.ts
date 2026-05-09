/**
 * commands/update.ts — Handle the /update command
 *
 * Transport-agnostic: receives a ProgressReporter interface,
 * not a Telegram-specific thread object.
 */

import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { provisionBundle } from "../provisioning/bundle";

const GLOBAL_PI_EXTENSION_PACKAGES = [
  "@inceptionstack/pi-hard-no",
  "@inceptionstack/pi-branch-enforcer",
];

export interface UpdateProgress {
  update(text: string): Promise<void>;
}

export interface UpdateResult {
  action: "already-latest" | "updated" | "error";
  currentVersion: string;
  latestVersion?: string;
  error?: string;
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
  let latestVersion: string;
  try {
    latestVersion = execSync("npm view @inceptionstack/roundhouse version 2>/dev/null", {
      timeout: 30_000,
      encoding: "utf8",
    }).trim();
  } catch (e) {
    // Update extensions anyway, but flag that version check failed
    latestVersion = "";
    console.warn("[roundhouse] npm view failed:", e instanceof Error ? e.message : e);
  }

  // Always update extensions (even if roundhouse is already latest)
  if (!latestVersion) {
    await progress.update(`⚠️ Version check failed — updating extensions only`);
  }
  for (const extensionPackage of GLOBAL_PI_EXTENSION_PACKAGES) {
    await progress.update(`📦 Updating extension: ${extensionPackage}...`);

    try {
      execSync(`npm install -g ${extensionPackage}@latest 2>&1`, {
        timeout: 60_000,
        encoding: "utf8",
      });
      await progress.update(`✅ ${extensionPackage} updated`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[roundhouse] failed to update extension ${extensionPackage}:`, msg);
      await progress.update(`⚠️ Failed to update ${extensionPackage}: ${msg.slice(0, 150)}`);
    }
  }

  if (!latestVersion) {
    return { action: "error", currentVersion, error: "Version check failed (extensions updated)" };
  }
  if (latestVersion === currentVersion) {
    return { action: "already-latest", currentVersion };
  }

  await progress.update(`📦 Updating v${currentVersion} → v${latestVersion}...`);

  try {
    execSync("npm install -g @inceptionstack/roundhouse@latest 2>&1", {
      timeout: 120_000,
      encoding: "utf8",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[roundhouse] self-update failed:", msg);
    return { action: "error", currentVersion, error: `Self-update failed: ${msg}` };
  }

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

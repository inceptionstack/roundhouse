/**
 * cli/update.ts — Handle the /update command
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

const SELF_PACKAGE = "@inceptionstack/roundhouse";

/**
 * Read globally-installed version of a package from disk.
 * Returns empty string if the package is not installed or query fails.
 *
 * Used both for pre-install version checks and for post-failure verification
 * (mise/nvm/npm reshim hooks can fail with exit 127 even after `npm install -g`
 * actually wrote the new version to disk — see PR fix/self-update-verify-on-failure).
 */
function getInstalledVersion(pkg: string): string {
  try {
    const out = execSync(`npm list -g ${pkg} --json --depth=0 2>/dev/null`, {
      timeout: 10_000,
      encoding: "utf8",
    });
    return JSON.parse(out)?.dependencies?.[pkg]?.version ?? "";
  } catch {
    return "";
  }
}

export interface UpdateProgress {
  update(text: string): Promise<void>;
}

export interface UpdateResult {
  action: "already-latest" | "updated" | "error";
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export async function updateExtensions(progress: UpdateProgress): Promise<void> {
  for (const extensionPackage of GLOBAL_PI_EXTENSION_PACKAGES) {
    let latestExtVersion = "";
    try {
      // Check if already at latest
      const installedVersion = getInstalledVersion(extensionPackage);
      latestExtVersion = execSync(`npm view ${extensionPackage} version 2>/dev/null`, {
        timeout: 10_000,
        encoding: "utf8",
      }).trim();

      if (installedVersion && installedVersion === latestExtVersion) {
        await progress.update(`✅ ${extensionPackage} already at v${installedVersion}`);
        continue;
      }
      await progress.update(`📦 Updating ${extensionPackage} v${installedVersion || "?"} → v${latestExtVersion}...`);
    } catch {
      await progress.update(`📦 Updating extension: ${extensionPackage}...`);
    }

    try {
      execSync(`npm install -g ${extensionPackage}@latest 2>&1`, {
        timeout: 60_000,
        encoding: "utf8",
      });
      await progress.update(`✅ ${extensionPackage} updated`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Verify-after-fail: post-install reshim hooks (mise/nvm) can exit non-zero
      // even when the package landed on disk correctly.
      const onDisk = getInstalledVersion(extensionPackage);
      if (onDisk && (!latestExtVersion || onDisk === latestExtVersion)) {
        console.warn(`[roundhouse] ${extensionPackage} install reported failure but v${onDisk} is on disk — treating as success:`, msg);
        await progress.update(`✅ ${extensionPackage} updated to v${onDisk} (post-install hook warned, ignored)`);
        continue;
      }
      console.warn(`[roundhouse] failed to update extension ${extensionPackage}:`, msg);
      await progress.update(`⚠️ Failed to update ${extensionPackage}: ${msg.slice(0, 150)}`);
    }
  }
}

export async function updateSelf(
  progress: UpdateProgress,
  currentVersion: string,
  latestVersion: string,
): Promise<string | undefined> {
  await progress.update(`📦 Updating v${currentVersion} → v${latestVersion}...`);

  try {
    execSync(`npm install -g ${SELF_PACKAGE}@latest 2>&1`, {
      timeout: 120_000,
      encoding: "utf8",
    });
    return undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Verify-after-fail: mise/nvm post-install reshim can exit 127 even when
    // npm wrote the new version to disk. Trust the on-disk state over the exit code.
    const onDisk = getInstalledVersion(SELF_PACKAGE);
    if (onDisk === latestVersion) {
      console.warn(`[roundhouse] self-update install reported failure but v${onDisk} is on disk — treating as success:`, msg);
      return undefined;
    }
    console.warn("[roundhouse] self-update failed:", msg);
    return `Self-update failed: ${msg}`;
  }
}

export function patchPiSettings(): void {
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
}

/**
 * Check for updates, install if newer, provision bundle, patch settings.
 * Returns the result — caller decides how to present it and whether to restart.
 */
export async function performUpdate(progress: UpdateProgress): Promise<UpdateResult> {
  const pkg = await import("../../package.json", { with: { type: "json" } });
  const currentVersion = pkg.default?.version ?? "unknown";

  let latestVersion: string;
  try {
    latestVersion = execSync(`npm view ${SELF_PACKAGE} version 2>/dev/null`, {
      timeout: 30_000,
      encoding: "utf8",
    }).trim();
  } catch (e) {
    // Update extensions anyway, but flag that version check failed
    latestVersion = "";
    console.warn("[roundhouse] npm view failed:", e instanceof Error ? e.message : e);
  }

  if (!latestVersion) {
    await progress.update(`⚠️ Version check failed — updating extensions only`);
  }
  await updateExtensions(progress);

  if (!latestVersion) {
    return { action: "error", currentVersion, error: "Version check failed (extensions updated)" };
  }
  if (latestVersion === currentVersion) {
    return { action: "already-latest", currentVersion };
  }

  const updateError = await updateSelf(progress, currentVersion, latestVersion);
  if (updateError) {
    return { action: "error", currentVersion, error: updateError };
  }

  try {
    provisionBundle();
  } catch (e) {
    console.warn("[roundhouse] bundle provisioning failed:", e instanceof Error ? e.message : e);
  }

  patchPiSettings();

  return { action: "updated", currentVersion, latestVersion };
}

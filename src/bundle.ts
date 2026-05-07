/**
 * bundle.ts — Shared bundle provisioning logic
 *
 * Used by both setup.ts (initial install) and gateway.ts (upgrade path).
 * All operations are non-fatal — failures are logged but don't throw.
 */

import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const SKILLS_REPO = "https://github.com/inceptionstack/loki-skills.git";
export const SKILLS_DIR = resolve(homedir(), ".pi", "agent", "skills");

export interface ProvisionLog {
  info(msg: string): void;
  warn(msg: string): void;
  ok(msg: string): void;
}

const consoleLog: ProvisionLog = {
  info: (msg) => console.log(`[roundhouse] ${msg}`),
  warn: (msg) => console.warn(`[roundhouse] ${msg}`),
  ok: (msg) => console.log(`[roundhouse] ✓ ${msg}`),
};

export interface ProvisionOpts {
  force?: boolean;
  log?: ProvisionLog;
}

function which(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync skills from loki-skills repo (additive — never deletes custom skills).
 * Removes existing skill dirs before copy to prevent nesting.
 * Returns number of skills synced.
 */
export function syncSkillsFromRepo(opts: ProvisionOpts = {}): number {
  const log = opts.log ?? consoleLog;

  if (!which("git")) {
    log.warn("git not found — skipping skill sync");
    return 0;
  }

  log.info("Syncing skills from inceptionstack/loki-skills...");
  const tmpDir = `/tmp/loki-skills-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(SKILLS_DIR, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--quiet", SKILLS_REPO, tmpDir], {
      stdio: "pipe", timeout: 60_000,
    });

    const entries = readdirSync(tmpDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith("."));

    let count = 0;
    for (const entry of entries) {
      const src = resolve(tmpDir, entry.name);
      const dest = resolve(SKILLS_DIR, entry.name);
      // Defense-in-depth: ensure dest stays within SKILLS_DIR
      if (!dest.startsWith(SKILLS_DIR + "/")) continue;
      try {
        execFileSync("rm", ["-rf", dest], { stdio: "pipe", timeout: 10_000 });
        execFileSync("cp", ["-r", src, dest], { stdio: "pipe", timeout: 30_000 });
        count++;
      } catch (e: any) {
        log.warn(`Failed to copy skill '${entry.name}': ${e.message}`);
      }
    }
    log.ok(`${count} skills synced to ~/.pi/agent/skills/`);
    return count;
  } catch (err: any) {
    log.warn(`Skill sync failed: ${err.message}`);
    return 0;
  } finally {
    try { execFileSync("rm", ["-rf", tmpDir], { stdio: "pipe" }); } catch {}
  }
}

/**
 * Install mcporter globally via npm.
 */
export function provisionMcporter(opts: ProvisionOpts = {}): void {
  const log = opts.log ?? consoleLog;
  if (which("mcporter") && !opts.force) {
    log.ok("mcporter (already installed)");
    return;
  }
  log.info("Installing mcporter...");
  try {
    execFileSync("npm", ["install", "-g", "mcporter"], { stdio: "pipe", timeout: 120_000 });
    log.ok("mcporter");
  } catch (err: any) {
    log.warn(`mcporter install failed: ${err.message}`);
  }
}

/**
 * Install @playwright/cli globally and download Chromium.
 */
export function provisionPlaywright(opts: ProvisionOpts = {}): void {
  const log = opts.log ?? consoleLog;
  const alreadyInstalled = which("playwright-cli");
  if (alreadyInstalled && !opts.force) {
    // Ensure Chromium is downloaded (idempotent — fast no-op if present)
    try {
      execFileSync("playwright-cli", ["install"], { stdio: "pipe", timeout: 300_000 });
    } catch {
      log.warn("Chromium may be missing — run 'playwright-cli install' manually");
    }
    log.ok("playwright-cli (already installed)");
    return;
  }
  log.info("Installing @playwright/cli...");
  try {
    execFileSync("npm", ["install", "-g", "@playwright/cli"], { stdio: "pipe", timeout: 120_000 });
    log.info("Downloading Chromium (one-time, ~186MB)...");
    try {
      execFileSync("playwright-cli", ["install"], { stdio: "pipe", timeout: 300_000 });
      log.ok("playwright-cli + Chromium");
    } catch {
      log.warn("Chromium download failed — run 'playwright-cli install' manually");
    }
  } catch (err: any) {
    log.warn(`playwright-cli install failed: ${err.message}`);
  }
}

/**
 * Install uv/uvx via official installer.
 */
export function provisionUvx(opts: ProvisionOpts = {}): void {
  const log = opts.log ?? consoleLog;
  const uvxPath = resolve(homedir(), ".local", "bin", "uvx");
  if ((which("uvx") || existsSync(uvxPath)) && !opts.force) {
    log.ok("uv/uvx (already installed)");
    return;
  }
  log.info("Installing uv/uvx...");
  try {
    execFileSync("bash", ["-c", "curl -fsSL https://astral.sh/uv/install.sh | sh"], {
      stdio: "pipe", timeout: 120_000,
      env: { ...process.env, HOME: homedir() },
    });
    log.ok("uv/uvx");
  } catch (err: any) {
    log.warn(`uv install failed: ${err.message}`);
    log.warn("Install manually: curl -LsSf https://astral.sh/uv/install.sh | sh");
  }
}

/**
 * Copy bundled mcporter.json to ~/.mcporter/ if missing or forced.
 */
export function provisionMcporterConfig(opts: ProvisionOpts = {}): void {
  const log = opts.log ?? consoleLog;
  const mcporterDir = resolve(homedir(), ".mcporter");
  const mcporterConfig = resolve(mcporterDir, "mcporter.json");
  if (existsSync(mcporterConfig) && !opts.force) {
    log.ok("~/.mcporter/mcporter.json (exists, keeping)");
    return;
  }
  try {
    const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "pi", "config", "mcporter.json");
    mkdirSync(mcporterDir, { recursive: true });
    writeFileSync(mcporterConfig, readFileSync(bundled, "utf8"), { mode: 0o644 });
    log.ok("~/.mcporter/mcporter.json");
  } catch (err: any) {
    log.warn(`mcporter config copy failed: ${err.message}`);
  }
}

/**
 * Provision all bundle dependencies (skills + CLI tools + config + extensions).
 * Non-fatal — logs warnings on failure but never throws.
 */
export function provisionBundle(opts: ProvisionOpts = {}): void {
  syncSkillsFromRepo(opts);
  provisionMcporter(opts);
  provisionPlaywright(opts);
  provisionUvx(opts);
  provisionMcporterConfig(opts);
  provisionExtensions(opts);
}

/**
 * Ensure core extensions are listed in ~/.pi/agent/settings.json packages array.
 */
export function provisionExtensions(opts: ProvisionOpts = {}): void {
  const { log = defaultLog } = opts;
  const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");

  const coreExtensions = [
    "npm:@inceptionstack/pi-hard-no",
    "npm:@inceptionstack/pi-branch-enforcer",
  ];

  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    }
    if (!Array.isArray(settings.packages)) settings.packages = [];
    const pkgs = settings.packages as string[];

    let added = 0;
    for (const ext of coreExtensions) {
      if (!pkgs.includes(ext)) {
        pkgs.push(ext);
        added++;
      }
    }

    if (added > 0) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      log.ok(`${added} extension(s) added to settings.json`);
    } else {
      log.ok("extensions (already configured)");
    }
  } catch (err: any) {
    log.warn(`extensions provisioning failed: ${err.message}`);
  }
}

/**
 * cli/setup/slack-flows.ts — `roundhouse setup --slack` interactive +
 * non-interactive flows.
 *
 * Mirrors `flows.ts` (telegram) but is dedicated to socket-mode Slack:
 *  - bot token + app token + (optional) signing secret
 *  - manifest printed inline + saved to /tmp for paste convenience
 *  - first-DM pairing (write pending file; the gateway completes it on
 *    first message.im or assistant_thread_started from an allowed user)
 *
 * We deliberately DO NOT reuse the telegram stepConfigure / stepStoreSecrets
 * because both encode telegram-specific secret names and adapter defaults.
 * Phase 5 documentation will note this — when a third transport lands we
 * can refactor a shared platform-agnostic configure step.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import {
  stepPreflight,
  stepStopGateway,
  stepInstallPackages,
  stepInstallBundle,
  stepInstallSystemd,
  stepPostflight,
} from "./steps";
import { atomicWriteJson, atomicWriteText } from "./helpers";
import { type SetupOptions } from "./types";
import { envQuote, parseEnvFile } from "../env-file";
import { promptText, promptMasked } from "./prompts";
import { resolveAgentForSetup, textLog, textStepLog, createStepLog } from "./runtime";
import { createJsonLogger, type SetupDiagnostics, printDiagnosticError } from "./logger";
import {
  validateSlackBotToken,
  validateSlackAppTokenShape,
  redactSlackToken,
  readBundledManifest,
  type SlackBotInfo,
} from "./slack";
import {
  writePendingSlackPairing,
  readPendingSlackPairing,
  type PendingSlackPairing,
} from "../../transports/slack/pairing";
import {
  ROUNDHOUSE_DIR,
  CONFIG_PATH,
  ENV_FILE_PATH as ENV_PATH,
  fileExists,
} from "../../config";

const SLACK_MANIFEST_TMP = resolve(tmpdir(), "roundhouse-slack-manifest.yaml");

// ── Slack-specific helpers ───────────────────────────

async function stepValidateSlackTokens(logger: ReturnType<typeof createStepLog>, opts: SetupOptions): Promise<SlackBotInfo> {
  logger.step("②", "Validating Slack tokens...");
  validateSlackAppTokenShape(opts.slackAppToken);
  const info = await validateSlackBotToken(opts.slackBotToken);
  logger.ok(`Bot: @${info.botName} (id: ${info.botUserId})`);
  logger.ok(`Workspace: ${info.teamName} (id: ${info.teamId})`);
  return info;
}

async function stepWriteSlackEnv(
  logger: ReturnType<typeof createStepLog>,
  opts: SetupOptions,
  info: SlackBotInfo,
): Promise<void> {
  logger.step("⑧", "Writing ~/.roundhouse/.env...");
  await mkdir(ROUNDHOUSE_DIR, { recursive: true });

  // Merge with existing env so unrelated keys (AWS_*, etc.) survive.
  let existing = new Map<string, string>();
  try { existing = parseEnvFile(await readFile(ENV_PATH, "utf8")); } catch {}

  // Use envQuote so values with `"`, `$`, backtick, or backslash round-trip
  // through parseEnvFile and don't trigger shell expansion in systemd's
  // EnvironmentFile parser.
  if (!opts.psst) {
    existing.set("SLACK_BOT_TOKEN", envQuote(opts.slackBotToken));
    existing.set("SLACK_APP_TOKEN", envQuote(opts.slackAppToken));
    if (opts.slackSigningSecret) existing.set("SLACK_SIGNING_SECRET", envQuote(opts.slackSigningSecret));
    // Only set BOT_USERNAME if not already present (preserve Telegram value in mixed installs)
    if (!existing.has("BOT_USERNAME")) existing.set("BOT_USERNAME", envQuote(info.botName));
    existing.set("ALLOWED_USERS", envQuote(opts.users.join(",")));
  } else {
    // psst path: still write non-secret config so systemd EnvironmentFile
    // has BOT_USERNAME / ALLOWED_USERS for the gateway warning logic.
    // Only set BOT_USERNAME if not already present (preserve Telegram value in mixed installs)
    if (!existing.has("BOT_USERNAME")) existing.set("BOT_USERNAME", envQuote(info.botName));
    existing.set("ALLOWED_USERS", envQuote(opts.users.join(",")));
  }

  // Bedrock defaults if needed (mirror telegram step)
  const getExisting = (key: string) => existing.get(key);
  if (opts.provider === "amazon-bedrock") {
    if (!existing.has("AWS_PROFILE")) existing.set("AWS_PROFILE", getExisting("AWS_PROFILE") ?? envQuote("default"));
    if (!existing.has("AWS_DEFAULT_REGION")) existing.set("AWS_DEFAULT_REGION", getExisting("AWS_DEFAULT_REGION") ?? envQuote("us-east-1"));
    if (!existing.has("AWS_REGION")) existing.set("AWS_REGION", getExisting("AWS_REGION") ?? getExisting("AWS_DEFAULT_REGION") ?? envQuote("us-east-1"));
  }

  const lines: string[] = [];
  for (const [k, v] of existing.entries()) lines.push(`${k}=${v}`);
  await atomicWriteText(ENV_PATH, lines.join("\n") + "\n");
  logger.ok(`~/.roundhouse/.env${opts.psst ? " (non-secret config only)" : ""}`);
}

async function stepWriteSlackConfig(
  logger: ReturnType<typeof createStepLog>,
  opts: SetupOptions,
  info: SlackBotInfo,
  agent: import("../../agents/registry").AgentDefinition,
): Promise<void> {
  logger.step("⑨", "Configuring agent + writing gateway.config.json...");

  await mkdir(ROUNDHOUSE_DIR, { recursive: true });

  // Run the agent's own configurator (writes ~/.pi/agent/settings.json
  // for pi, etc.). Telegram's stepConfigure does the same.
  if (agent.configure) {
    await agent.configure({
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
      force: opts.force,
      psst: opts.psst,
      extensions: opts.extensions,
    });
  }

  let gatewayConfig: Record<string, any> = {};
  if (!opts.force) {
    try { gatewayConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch {}
  }

  const existingUsers: string[] = gatewayConfig.chat?.allowedUsers ?? [];
  const existingUserIds: (string | number)[] = gatewayConfig.chat?.allowedUserIds ?? [];
  const existingNotifyIds: (string | number)[] = gatewayConfig.chat?.notifyChatIds ?? [];

  const mergedUsers = [...new Set([...existingUsers, ...opts.users])];
  // Phase 3 doesn't pre-populate allowedUserIds — pairing fills it via the gateway hook.
  const mergedUserIds = [...existingUserIds];
  const mergedNotifyIds = [...new Set<string | number>([...existingNotifyIds, ...opts.notifyChatIds])];

  // Preserve telegram adapter config if already set (multi-transport coexistence).
  const existingAdapters = gatewayConfig.chat?.adapters ?? {};

  gatewayConfig = {
    ...gatewayConfig,
    _version: 1,
    agent: {
      ...gatewayConfig.agent,
      ...agent.configDefaults,
      type: agent.type,
      cwd: opts.cwd,
    },
    chat: {
      ...gatewayConfig.chat,
      allowedUsers: mergedUsers,
      allowedUserIds: mergedUserIds,
      notifyChatIds: mergedNotifyIds,
      adapters: { ...existingAdapters, slack: { mode: "socket", botUsername: info.botName } },
    },
    ...(opts.voice === false ? { voice: { stt: { enabled: false } } } : {}),
  };

  await atomicWriteJson(CONFIG_PATH, gatewayConfig);
  logger.ok(`~/.roundhouse/gateway.config.json (slack adapter configured)`);
}

async function stepStoreSlackSecrets(
  logger: ReturnType<typeof createStepLog>,
  opts: SetupOptions,
  info: SlackBotInfo,
): Promise<void> {
  if (!opts.psst) {
    logger.step("⑦", "Storing secrets...");
    logger.ok("Skipped (default — use --with-psst to enable)");
    return;
  }
  logger.step("⑦", "Storing secrets in psst...");
  const secrets: [string, string][] = [
    ["SLACK_BOT_TOKEN", opts.slackBotToken],
    ["SLACK_APP_TOKEN", opts.slackAppToken],
    ["BOT_USERNAME", info.botName],
    ["ALLOWED_USERS", opts.users.join(",")],
  ];
  if (opts.slackSigningSecret) secrets.push(["SLACK_SIGNING_SECRET", opts.slackSigningSecret]);

  for (const [name, value] of secrets) {
    try {
      execFileSync("psst", ["set", name, "--stdin"], {
        input: value,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
      logger.ok(`${name} → psst vault`);
    } catch {
      try {
        execFileSync("psst", ["set", name, "--stdin"], {
          input: value,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
          env: { ...process.env, PSST_FORCE: "1" },
        });
        logger.ok(`${name} → psst vault (updated)`);
      } catch (err: any) {
        logger.warn(`Failed to store ${name} in psst: ${err.message}`);
      }
    }
  }
}

async function stepWriteSlackPairing(
  logger: ReturnType<typeof createStepLog>,
  opts: SetupOptions,
  info: SlackBotInfo,
): Promise<PendingSlackPairing> {
  logger.step("⑩", "Writing slack-pairing.json (status: pending)...");
  const existing = await readPendingSlackPairing();
  const pending: PendingSlackPairing = {
    version: 1,
    workspaceTeamId: info.teamId,
    botUserId: info.botUserId,
    allowedUsers: opts.users,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    status: "pending",
  };
  await writePendingSlackPairing(pending);
  logger.ok(`~/.roundhouse/slack-pairing.json`);
  return pending;
}

async function stepDumpManifest(logger: ReturnType<typeof createStepLog>): Promise<string> {
  const manifest = await readBundledManifest();
  await writeFile(SLACK_MANIFEST_TMP, manifest, { mode: 0o600 });
  logger.ok(`Slack app manifest copied to ${SLACK_MANIFEST_TMP}`);
  return manifest;
}

function printSlackAppGuide(): void {
  textLog("");
  textLog("  📱 Create / update the Slack app");
  textLog("  ────────────────────────────────");
  textLog("  1. Open https://api.slack.com/apps → 'Create New App' → 'From an app manifest'");
  textLog("  2. Pick the workspace, paste the manifest from below (also saved to /tmp)");
  textLog("  3. Click 'Create' → 'Install to Workspace' → review scopes → 'Allow'");
  textLog("  4. Open 'Basic Information' → scroll to 'App-Level Tokens' → 'Generate Token and Scopes'");
  textLog("       Add scope: connections:write");
  textLog("       Copy the xapp-… token");
  textLog("  5. Open 'OAuth & Permissions' → copy the 'Bot User OAuth Token' (xoxb-…)");
  textLog("");
}

function printSlackPairingHint(info: SlackBotInfo, opts: SetupOptions): void {
  const allowedDisplay = opts.users.length
    ? opts.users.map((u) => `@${u}`).join(", ")
    : "@your-slack-username";
  textLog("");
  textLog("  🤝 Pairing");
  textLog("  ─────────");
  textLog(`  In Slack, open a NEW DM with @${info.botName} and send any message.`);
  textLog(`  (Click the bot in your sidebar, or search 'Apps' → @${info.botName}.)`);
  textLog(`  The first message from one of: ${allowedDisplay} will complete pairing.`);
  textLog("");
  textLog(`  Open the bot in Slack: slack://app?team=${info.teamId}&id=${info.botUserId}`);
  textLog("");
}

// ── Interactive flow ─────────────────────────────────

export async function runInteractiveSlackSetup(opts: SetupOptions): Promise<void> {
  const logger = textStepLog;
  const agent = resolveAgentForSetup(opts, logger);
  textLog("\n🔧 Roundhouse Slack Setup");
  textLog("━━━━━━━━━━━━━━━━━━━━━━━━━");

  try {
    await stepPreflight(logger, opts, agent);
    await stepDumpManifest(logger);
    printSlackAppGuide();

    const manifest = await readBundledManifest();
    textLog("  ── Slack app manifest ──");
    for (const line of manifest.split("\n")) textLog(`  ${line}`);
    textLog("  ────────────────────────");
    textLog("");

    if (!opts.slackBotToken) {
      opts.slackBotToken = await promptMasked("  Paste your Slack bot token (xoxb-…)");
      if (!opts.slackBotToken) { logger.fail("No bot token provided"); process.exit(2); }
    }
    if (!opts.slackAppToken) {
      opts.slackAppToken = await promptMasked("  Paste your Slack app-level token (xapp-…)");
      if (!opts.slackAppToken) { logger.fail("No app token provided"); process.exit(2); }
    }

    const info = await stepValidateSlackTokens(logger, opts);

    if (opts.users.length === 0) {
      logger.step("③", "Slack username...");
      const username = await promptText("  Your Slack username (without @)");
      if (!username) { logger.fail("Username required"); process.exit(2); }
      opts.users.push(username.replace(/^@/, ""));
      logger.ok(`Allowed: ${opts.users.map((u) => `@${u}`).join(", ")}`);
    }

    await stepStopGateway(logger);
    await stepInstallPackages(logger, opts, agent);
    await stepInstallBundle(logger, opts);

    await stepStoreSlackSecrets(logger, opts, info);
    await stepWriteSlackEnv(logger, opts, info);
    await stepWriteSlackConfig(logger, opts, info, agent);
    await stepWriteSlackPairing(logger, opts, info);

    await stepInstallSystemd(logger, opts);
    await stepPostflight(logger);

    printSlackPairingHint(info, opts);

    textLog("\n━━━━━━━━━━━━━━━━━━━━━━━━━");
    textLog("✅ Roundhouse is ready!");
    textLog(`   Bot: @${info.botName} in ${info.teamName}`);
    textLog(`   Tokens stored in ~/.roundhouse/.env (slack: ${redactSlackToken(opts.slackBotToken)} / ${redactSlackToken(opts.slackAppToken)}).`);
    textLog(`   DM @${info.botName} in Slack to complete pairing.`);
    textLog("");
  } catch (err: any) {
    textLog("\n━━━━━━━━━━━━━━━━━━━━━━━━━");
    textLog(`❌ Setup failed: ${err.message}`);
    textLog("   Re-run: roundhouse setup --slack\n");
    process.exit(1);
  }
}

// ── Non-interactive flow ─────────────────────────────

export async function runNonInteractiveSlackSetup(opts: SetupOptions): Promise<void> {
  const logger = createJsonLogger();
  const stepLogger = createStepLog(logger);
  const agent = resolveAgentForSetup(opts, stepLogger);

  try {
    if (!opts.slackBotToken) {
      logger.error("validation.failed", "SLACK_BOT_TOKEN env var required for --non-interactive");
      process.exit(2);
    }
    if (!opts.slackAppToken) {
      logger.error("validation.failed", "SLACK_APP_TOKEN env var required for --non-interactive");
      process.exit(2);
    }
    if (opts.users.length === 0) {
      logger.error("validation.failed", "--user is required for --non-interactive");
      process.exit(2);
    }

    logger.step(1, 9, "preflight.start", "Running preflight checks");
    await stepPreflight(stepLogger, opts, agent);
    logger.ok("Preflight passed");

    logger.step(2, 9, "slack.validate", "Validating Slack tokens");
    const info = await stepValidateSlackTokens(stepLogger, opts);
    logger.ok(`Bot: @${info.botName} workspace=${info.teamName}`);

    logger.step(3, 9, "gateway.stop", "Checking for running gateway");
    await stepStopGateway(stepLogger);

    logger.step(4, 9, "packages.install", "Installing packages");
    await stepInstallPackages(stepLogger, opts, agent);
    logger.ok("Packages installed");

    await stepInstallBundle(stepLogger, opts);

    logger.step(5, 10, "slack.secrets.store", "Storing secrets");
    await stepStoreSlackSecrets(stepLogger, opts, info);

    logger.step(6, 10, "slack.env.write", "Writing env");
    await stepWriteSlackEnv(stepLogger, opts, info);

    logger.step(7, 10, "slack.config.write", "Writing config");
    await stepWriteSlackConfig(stepLogger, opts, info, agent);

    logger.step(8, 10, "slack.pairing.write", "Writing pending-pairing");
    await stepWriteSlackPairing(stepLogger, opts, info);

    logger.step(9, 10, "slack.manifest", "Saving manifest to /tmp");
    await stepDumpManifest(stepLogger);

    let serviceInstalled = false;
    logger.step(10, 10, "service.install", "Installing service");
    if (!opts.systemd && platform() !== "darwin") {
      logger.warn("service.skip", "--no-systemd: service not installed. Start manually: roundhouse start");
    } else {
      await stepInstallSystemd(stepLogger, opts);
      try {
        const state = execFileSync("systemctl", ["is-active", "roundhouse"], { encoding: "utf8" }).trim();
        if (state === "active") {
          logger.ok("Service is active");
          serviceInstalled = true;
        } else {
          logger.warn("service.state", `Service state: ${state}`);
        }
      } catch {
        logger.warn("service.state", "Could not verify service state");
      }
    }

    logger.info("setup.complete", "Non-interactive Slack setup complete", {
      botName: info.botName,
      botUserId: info.botUserId,
      teamId: info.teamId,
      pairingStatus: "pending",
      serviceInstalled,
    });
    stepLogger.log("");
    stepLogger.log("━━━━━━━━━━━━━━━━━━━━━━━━━");
    stepLogger.log("✅ Roundhouse Slack installed!");
    stepLogger.log("");
    stepLogger.log(`   DM @${info.botName} in Slack to complete pairing.`);
  } catch (err: any) {
    const diag: SetupDiagnostics = {
      node: process.version,
      platform: platform(),
      arch: process.arch,
      cwd: process.cwd(),
      roundhouseDir: ROUNDHOUSE_DIR,
      configExists: await fileExists(CONFIG_PATH).catch(() => false),
      envExists: await fileExists(ENV_PATH).catch(() => false),
      pairingStatus: (await readPendingSlackPairing())?.status ?? "not found",
      serviceState: "unknown",
      error: { name: err.name, message: err.message, stack: err.stack },
    };
    try {
      diag.serviceState = execFileSync("systemctl", ["is-active", "roundhouse"], { encoding: "utf8" }).trim();
    } catch {}
    printDiagnosticError(diag, true);
    process.exit(1);
  }
}


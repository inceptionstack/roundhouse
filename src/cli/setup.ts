/**
 * cli/setup.ts — One-command install & configure for roundhouse
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... npx @inceptionstack/roundhouse setup --user badlogicgames
 *   roundhouse setup --bot-token "TOKEN" --user badlogicgames
 *
 * Installs roundhouse + pi + psst, configures everything, pairs Telegram,
 * and starts the systemd service.
 */

import { readFile } from "node:fs/promises";
import { BOT_COMMANDS } from "../transports/telegram/bot-commands";
import { atomicWriteJson, execSafe } from "./setup/helpers";
import { type SetupOptions } from "./setup/types";
import { parseSetupArgs } from "./setup/args";
export { parseSetupArgs } from "./setup/args";
import {
  CONFIG_PATH,
  ENV_FILE_PATH as ENV_PATH,
} from "../config";
import { parseEnvFile, unquoteEnvValue } from "./env-file";
import {
  getAgentDefinition,
  listAvailableAgentTypes,
} from "../agents/registry";
import {
  validateBotToken,
  pairTelegram,
} from "./setup/telegram";
import {
  stepPreflight,
  stepValidateToken,
  stepStopGateway,
  stepInstallPackages,
  stepStoreSecrets,
  stepInstallBundle,
  stepConfigure,
  stepPair,
  stepRegisterCommands,
  stepInstallSystemd,
  stepPostflight,
} from "./setup/steps";
import { resolveAgentForSetup, textLog, textStepLog } from "./setup/runtime";
import { runInteractiveTelegramSetup, runNonInteractiveTelegramSetup } from "./setup/flows";

// ── Orchestrator ─────────────────────────────────────

export async function cmdSetup(argv: string[]): Promise<void> {
  let opts: SetupOptions;
  try {
    opts = parseSetupArgs(argv);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    printSetupHelp();
    process.exit(1);
  }

  if (opts.dryRun) {
    printDryRun(opts);
    return;
  }

  // Route to --telegram flows
  if (opts.telegram) {
    if (opts.nonInteractive) {
      await runNonInteractiveTelegramSetup(opts);
    } else {
      await runInteractiveTelegramSetup(opts);
    }
    return;
  }

  // Legacy flow (no --telegram flag)
  const logger = textStepLog;
  const agent = resolveAgentForSetup(opts, logger);
  textLog("\n🔧 Roundhouse Setup");
  textLog("━━━━━━━━━━━━━━━━━━━");

  try {
    // Phase 1: Validate (no mutations)
    await stepPreflight(logger, opts, agent);
    const botInfo = await stepValidateToken(logger, opts);
    await stepStopGateway(logger);

    // Phase 2: Install packages
    await stepInstallPackages(logger, opts, agent);

    // Phase 2b: Install bundle (skills + CLI tools)
    await stepInstallBundle(logger, opts);

    // Phase 3: Pair (before secrets/config, so paired username is included)
    const pairResult = await stepPair(logger, opts, botInfo);

    // Phase 4: Store secrets (after pairing, so ALLOWED_USERS includes paired user)
    await stepStoreSecrets(logger, opts, botInfo);

    // Phase 5: Write config (includes pair data)
    await stepConfigure(logger, opts, botInfo, pairResult, agent);

    // Phase 6: Remote setup
    await stepRegisterCommands(logger, opts);

    // Phase 7: Service
    await stepInstallSystemd(logger, opts);

    // Phase 8: Verify
    await stepPostflight(logger);

    // Final message
    const warnings = !opts.notifyChatIds.length && !pairResult;
    textLog("\n━━━━━━━━━━━━━━━━━━━");
    if (warnings) {
      textLog("⚠️  Installed, action required:");
      textLog(`   • Not paired — run: roundhouse pair`);
    } else {
      textLog("✅ Roundhouse is running!");
    }
    textLog(`   Bot: @${botInfo.username}`);
    textLog(`   Memory: ${opts.extensions.some((e) => e.includes("pi-memory")) ? "agent-managed" : "roundhouse-managed"}`);
    textLog(`   Secrets: ${opts.psst ? "psst vault (encrypted)" : "~/.roundhouse/.env (plaintext)"}`);
    textLog(`   Send /status to @${botInfo.username} on Telegram.\n`);
  } catch (err: any) {
    textLog("\n━━━━━━━━━━━━━━━━━━━");
    textLog(`❌ Setup failed: ${err.message}`);
    textLog("   Partial changes may have been applied.");
    textLog("   Re-run setup to complete, or run: roundhouse doctor\n");
    process.exit(1);
  }
}

// ── Pair command ─────────────────────────────────────

export async function cmdPair(argv: string[]): Promise<void> {
  // Load token from psst, env, or flag
  let token = "";
  let users: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bot-token" && argv[i + 1]) token = argv[++i];
    else if (argv[i] === "--user" && argv[i + 1]) users.push(argv[++i].replace(/^@/, ""));
  }

  // Try env
  if (!token) token = process.env.TELEGRAM_BOT_TOKEN ?? "";

  // Try psst
  if (!token) {
    token = execSafe("psst", ["get", "TELEGRAM_BOT_TOKEN"], { silent: true });
  }

  // Try existing env file
  if (!token) {
    try {
      const entries = parseEnvFile(await readFile(ENV_PATH, "utf8"));
      const raw = entries.get("TELEGRAM_BOT_TOKEN");
      if (raw) token = unquoteEnvValue(raw);
    } catch {}
  }

  if (!token) {
    console.error("No bot token found. Provide via --bot-token, TELEGRAM_BOT_TOKEN env, or psst vault.");
    process.exit(1);
  }

  // Load users from config if not provided
  if (users.length === 0) {
    try {
      const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      users = config.chat?.allowedUsers ?? [];
    } catch {}
  }

  if (users.length === 0) {
    console.error("No users specified. Provide --user USERNAME or configure allowedUsers in gateway config.");
    process.exit(1);
  }

  textLog("\n🔗 Roundhouse Pairing\n");

  const botInfo = await validateBotToken(token);
  textStepLog.ok(`Bot: @${botInfo.username}`);

  const result = await pairTelegram(token, botInfo.username, users, 300_000, textLog);

  if (!result) {
    textLog("\n⚠ Pairing timed out. Try again: roundhouse pair\n");
    process.exit(1);
  }

  textStepLog.ok(`Paired with @${result.username} (user id: ${result.userId}, chat: ${result.chatId})`);

  // Update config
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    if (!config.chat) config.chat = {};
    const existingUserIds: number[] = config.chat.allowedUserIds ?? [];
    const existingNotifyIds: number[] = (config.chat.notifyChatIds ?? []).map(Number).filter((n) => !isNaN(n));

    if (!existingUserIds.includes(result.userId)) existingUserIds.push(result.userId);
    if (!existingNotifyIds.includes(result.chatId)) existingNotifyIds.push(result.chatId);

    config.chat.allowedUserIds = existingUserIds;
    config.chat.notifyChatIds = existingNotifyIds;

    await atomicWriteJson(CONFIG_PATH, config);
    textStepLog.ok("Config updated with chat ID");
  } catch {
    textStepLog.warn("Could not update config — add notifyChatIds manually");
  }

  textLog("\n✅ Paired! Restart gateway to apply: roundhouse restart\n");
}

// ── Dry run ──────────────────────────────────────────

function printDryRun(opts: SetupOptions): void {
  const agent = getAgentDefinition(opts.agent);
  textLog("\n🔧 Roundhouse Setup (DRY RUN)");
  textLog("━━━━━━━━━━━━━━━━━━━\n");
  textLog(`Agent: ${agent.name} (${agent.type})`);
  textLog("Would validate Telegram token");
  textLog("Would stop existing gateway (if running)");
  textLog(`Would install: npm install -g @inceptionstack/roundhouse`);
  for (const pkg of agent.packages) {
    const scope = pkg.install === "global" ? "-g " : "";
    textLog(`Would install: npm install ${scope}${pkg.packageName}`);
  }
  if (opts.psst) {
    textLog(`Would install: bun runtime (if not present)`);
    textLog(`Would install: npm install -g psst-cli`);
    textLog(`Would initialize psst vault`);
    textLog(`Would install: pi-psst extension`);
  }
  for (const ext of opts.extensions) textLog(`Would install extension: ${ext}`);
  if (!opts.nonInteractive && opts.notifyChatIds.length === 0) {
    textLog(`Would pair via Telegram (interactive)`);
  }
  if (opts.psst) {
    textLog(`Would store TELEGRAM_BOT_TOKEN, BOT_USERNAME, ALLOWED_USERS in psst`);
  }
  if (agent.configDirs?.length) {
    textLog(`Would configure: agent-specific settings`);
    textLog(`  Agent: ${agent.name}`);
  }
  textLog(`  Set defaultProvider: ${opts.provider}`);
  textLog(`  Set defaultModel: ${opts.model}`);
  textLog(`Would write: ~/.roundhouse/gateway.config.json`);
  textLog(`Would write: ~/.roundhouse/.env${opts.psst ? " (non-secret config only)" : ""}`);
  textLog(`Would register ${BOT_COMMANDS.length} bot commands`);
  if (opts.systemd) textLog(`Would install systemd service`);
  textLog("\nNo changes made.\n");
}

// ── Help ─────────────────────────────────────────────

function printSetupHelp(): void {
  console.log(`
Usage:
  roundhouse setup --telegram                     Interactive wizard (recommended)
  TELEGRAM_BOT_TOKEN=... roundhouse setup \\\n    --telegram --non-interactive --user USERNAME   Non-interactive automation (SSM/cloud-init)
  TELEGRAM_BOT_TOKEN=... roundhouse setup \\\n    --user USERNAME                                Legacy (non-wizard) setup

Modes:
  --telegram                 Telegram-focused setup (wizard or non-interactive)
  --non-interactive           Suppress all prompts (for automation/SSM/cloud-init)
                             Requires TELEGRAM_BOT_TOKEN env var and --user

Required (or prompted in interactive --telegram):
  --user <username>          Telegram username (repeatable, strips @)

Token:
  TELEGRAM_BOT_TOKEN env     Preferred — not in shell history
  --bot-token <token>        Accepted in interactive mode only

Agent:
  --agent <type>             Agent type (default: pi; available: ${listAvailableAgentTypes().join(", ")})
  --provider <provider>      AI provider (default: amazon-bedrock)
  --model <model>            AI model (default: us.anthropic.claude-opus-4-6-v1)
  --extension <pkg>          Agent extension (repeatable)
  --cwd <path>               Agent working directory (default: ~)

Channel:
  --notify-chat <id>         Telegram chat ID (repeatable, skips pairing)

Service:
  --no-systemd               Skip systemd install
  --no-voice                 Disable voice/STT
  --with-psst                Use psst vault for secrets (default: .env file)

Display:
  --qr                       Force QR code display
  --no-qr                    Disable QR code display

Behavior:
  --non-interactive          No pairing, no prompts
  --force                    Overwrite existing configs
  --dry-run                  Preview without changes
`);
}

import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { type SetupOptions } from "./types";
import { promptText, promptMasked } from "../setup-prompts";
import { createJsonLogger, type SetupDiagnostics, printDiagnosticError } from "../setup-logger";
import { printQr } from "../qr";
import {
  createPairingNonce,
  createPairingLink,
  readPendingPairing,
  writePendingPairing,
  type PendingPairing,
} from "../../pairing";
import { detectEnvironment, formatDetectionResults } from "../detect";
import { fileExists, ROUNDHOUSE_DIR, CONFIG_PATH, ENV_FILE_PATH as ENV_PATH } from "../../config";
import { pairTelegram } from "../setup-telegram";
import {
  stepPreflight,
  stepValidateToken,
  stepStopGateway,
  stepInstallPackages,
  stepStoreSecrets,
  stepInstallBundle,
  stepConfigure,
  stepRegisterCommands,
  stepInstallSystemd,
  stepPostflight,
} from "./steps";
import { resolveAgentForSetup, textLog, textStepLog, createStepLog } from "./runtime";

export async function runInteractiveTelegramSetup(opts: SetupOptions): Promise<void> {
  const logger = textStepLog;
  const agent = resolveAgentForSetup(opts, logger);
  textLog("\n🔧 Roundhouse Telegram Setup");
  textLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  try {
    await stepPreflight(logger, opts, agent);

    const env = detectEnvironment();
    if (env.agents.length > 0) {
      textLog("");
      textLog("  🔍 Agent detection:");
      for (const line of formatDetectionResults(env)) {
        logger.ok(line);
      }
      if (!opts.force) {
        const selected = env.agents.find(a => a.type === opts.agent);
        if (selected?.configured) {
          opts._skipAgentInstall = true;
        }
      }
    }

    if (!opts.botToken) {
      textLog("");
      printBotFatherGuide();
      opts.botToken = await promptMasked("  Paste your bot token");
      if (!opts.botToken) {
        logger.fail("No token provided");
        process.exit(2);
      }
    }
    const botInfo = await stepValidateToken(logger, opts);

    if (opts.users.length === 0) {
      logger.step("③", "Telegram username...");
      const username = await promptText("  Your Telegram username (without @)");
      if (!username) {
        logger.fail("Username required");
        process.exit(2);
      }
      opts.users.push(username.replace(/^@/, ""));
      logger.ok(`Allowed: ${opts.users.map(u => `@${u}`).join(", ")}`);
    }

    await stepStopGateway(logger);
    await stepInstallPackages(logger, opts, agent);
    await stepInstallBundle(logger, opts);

    logger.step("⑦", "Pairing with Telegram...");
    const nonce = createPairingNonce();
    const pairingLink = createPairingLink(botInfo.username, nonce);
    textLog(`\n  Open this link to pair:\n`);
    textLog(`  🔗 ${pairingLink}\n`);
    printQr(pairingLink, opts.qr);
    textLog(`  Or send /start ${nonce} to @${botInfo.username}`);
    textLog("");

    if (process.platform === "darwin") {
      try {
        execFileSync("open", [pairingLink], { stdio: "ignore" });
        textLog("  (Opened in Telegram — switch to the app to complete pairing)");
      } catch {}
    }

    textLog("  Waiting for you to tap the link in Telegram...");

    const pairResult = await pairTelegram(
      opts.botToken, botInfo.username, opts.users,
      300_000, textLog, { nonce, showLink: false },
    );
    if (!pairResult) {
      logger.warn("Pairing timed out. Run 'roundhouse pair' later.");
    } else {
      logger.ok(`Paired with @${pairResult.username} (chat: ${pairResult.chatId})`);
      if (!opts.notifyChatIds.includes(pairResult.chatId)) {
        opts.notifyChatIds.push(pairResult.chatId);
      }
    }

    await stepStoreSecrets(logger, opts, botInfo);
    await stepConfigure(logger, opts, botInfo, pairResult, agent);
    await stepRegisterCommands(logger, opts);
    await stepInstallSystemd(logger, opts);
    await stepPostflight(logger);

    textLog("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    textLog("✅ Roundhouse is ready!");
    textLog(`   Bot: @${botInfo.username}`);
    textLog(`   Send /status to @${botInfo.username} on Telegram.\n`);
  } catch (err: any) {
    textLog("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    textLog(`❌ Setup failed: ${err.message}`);
    textLog("   Re-run: roundhouse setup --telegram\n");
    process.exit(1);
  }
}

export async function runHeadlessTelegramSetup(opts: SetupOptions): Promise<void> {
  const logger = createJsonLogger();
  const stepLogger = createStepLog(logger);
  const agent = resolveAgentForSetup(opts, stepLogger);

  try {
    if (!opts.botToken) {
      logger.error("validation.failed", "TELEGRAM_BOT_TOKEN env var required for --headless");
      process.exit(2);
    }
    if (opts.users.length === 0) {
      logger.error("validation.failed", "--user is required for --headless");
      process.exit(2);
    }

    logger.step(1, 9, "preflight.start", "Running preflight checks");
    await stepPreflight(stepLogger, opts, agent);
    logger.ok("Preflight passed");

    logger.step(2, 9, "telegram.validate", "Validating Telegram bot token");
    const botInfo = await stepValidateToken(stepLogger, opts);
    logger.ok(`Bot: @${botInfo.username} (id: ${botInfo.id})`);

    logger.step(3, 9, "gateway.stop", "Checking for running gateway");
    await stepStopGateway(stepLogger);

    logger.step(4, 9, "packages.install", "Installing packages");
    await stepInstallPackages(stepLogger, opts, agent);
    logger.ok("Packages installed");

    await stepInstallBundle(stepLogger, opts);

    logger.step(5, 9, "pairing.pending", "Creating pending pairing");
    let nonce: string;
    const existing = await readPendingPairing();
    if (existing?.status === "pending" && !opts.force) {
      nonce = existing.nonce;
      logger.info("pairing.reuse", `Reusing existing nonce: ${nonce}`);
    } else {
      nonce = createPairingNonce();
    }
    const pairingLink = createPairingLink(botInfo.username, nonce);
    const pendingPairing: PendingPairing = {
      version: 1,
      nonce,
      botUsername: botInfo.username,
      allowedUsers: opts.users,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await writePendingPairing(pendingPairing);
    logger.info("pairing.link", `Pairing link: ${pairingLink}`, { pairingLink, nonce });

    logger.step(6, 9, "secrets.store", "Storing secrets");
    await stepStoreSecrets(stepLogger, opts, botInfo);

    logger.step(7, 9, "config.write", "Writing configuration");
    await stepConfigure(stepLogger, opts, botInfo, null, agent);
    logger.ok("Config written");

    logger.step(8, 9, "commands.register", "Registering bot commands");
    await stepRegisterCommands(stepLogger, opts);
    logger.ok("Bot commands registered");

    let serviceInstalled = false;
    logger.step(9, 9, "service.install", "Installing and starting service");
    if (!opts.systemd && platform() !== "darwin") {
      logger.warn("service.skip", "--no-systemd: service not installed. Start manually: roundhouse start");
    } else {
      await stepInstallSystemd(stepLogger, opts);

      if (platform() === "darwin") {
        try {
          const { isLaunchAgentRunning } = await import("../launchd.ts");
          if (isLaunchAgentRunning()) {
            logger.ok("LaunchAgent is running");
            serviceInstalled = true;
          } else {
            logger.warn("service.state", "LaunchAgent loaded but not yet running");
          }
        } catch {
          logger.warn("service.state", "Could not verify LaunchAgent state");
        }
      } else {
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
    }

    logger.info("setup.complete", "Headless setup complete", {
      botUsername: botInfo.username,
      pairingLink,
      pairingStatus: "pending",
      serviceInstalled,
    });
    stepLogger.log("");
    stepLogger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    stepLogger.log(`✅ Roundhouse installed and running!`);
    stepLogger.log(``);
    stepLogger.log(`   Bot: @${botInfo.username}`);
    stepLogger.log(`   Pairing: Open ${pairingLink} to complete setup`);
    stepLogger.log(`   Gateway is running and will accept pairing automatically.`);
    stepLogger.log(``);
  } catch (err: any) {
    const diag: SetupDiagnostics = {
      node: process.version,
      platform: platform(),
      arch: process.arch,
      cwd: process.cwd(),
      roundhouseDir: ROUNDHOUSE_DIR,
      configExists: await fileExists(CONFIG_PATH).catch(() => false),
      envExists: await fileExists(ENV_PATH).catch(() => false),
      pairingStatus: (await readPendingPairing())?.status ?? "not found",
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

function printBotFatherGuide(): void {
  textLog("");
  textLog("  🤖 Create a Telegram Bot");
  textLog("  ────────────────────────");
  textLog("  1. Open https://t.me/BotFather");
  textLog("  2. Send /newbot");
  textLog("  3. Choose a display name (e.g. 'My Roundhouse')");
  textLog("  4. Choose a username ending in 'bot' (e.g. 'my_roundhouse_bot')");
  textLog("  5. Copy the token BotFather returns");
  textLog("");
}

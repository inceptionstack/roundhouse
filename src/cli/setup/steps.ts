import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir, unlink, realpath, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BOT_COMMANDS } from "../../transports/telegram/bot-commands";
import { provisionBundle, type ProvisionLog } from "../../bundle";
import {
  ROUNDHOUSE_DIR,
  CONFIG_PATH,
  ENV_FILE_PATH as ENV_PATH,
  fileExists,
} from "../../config";
import { type AgentDefinition } from "../../agents/registry";
import { envQuote, parseEnvFile } from "../env-file";
import { atomicWriteJson, atomicWriteText, execSafe, execOrFail } from "./helpers";
import { type SetupOptions, type StepLog } from "./types";
import {
  whichSync,
  systemctl,
  isServiceActive,
  systemctlShow,
  resolveExecStart,
  generateUnit,
  writeServiceUnit,
  hasSudoAccess,
} from "../systemd";
import {
  validateBotToken,
  checkWebhook,
  registerBotCommands,
  pairTelegram,
  sendMessage,
  type BotInfo,
  type PairResult,
} from "../setup-telegram";

export async function stepPreflight(logger: StepLog, opts: SetupOptions, agent: AgentDefinition): Promise<void> {
  logger.step("①", "Preflight checks...");

  const nodeVer = process.version;
  const major = parseInt(nodeVer.replace("v", ""));
  if (major < 20) {
    logger.fail(`Node.js ${nodeVer} — version 20+ required`);
    throw new Error("Node.js 20+ required");
  }
  logger.ok(`Node.js ${nodeVer}`);

  if (!whichSync("npm")) {
    logger.fail("npm not found on PATH");
    throw new Error("npm required");
  }
  logger.ok("npm available");

  const dirs = [ROUNDHOUSE_DIR, ...(agent.configDirs ?? [])];
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
      logger.ok(`Writable: ${dir.replace(homedir(), "~")}`);
    } catch {
      logger.fail(`Cannot create: ${dir}`);
      throw new Error(`Cannot write to ${dir}`);
    }
  }

  if (!(await fileExists(ENV_PATH))) {
    const seed = [
      "# Roundhouse environment file",
      "# Uncomment and set values, or use: roundhouse setup",
      "#",
      "# TELEGRAM_BOT_TOKEN=\"your-bot-token\"",
      "# BOT_USERNAME=\"your_bot_username\"",
      "# ALLOWED_USERS=\"your_telegram_username\"",
      "# AWS_PROFILE=\"default\"",
      "# AWS_REGION=\"us-east-1\"",
      "",
    ].join("\n");
    await writeFile(ENV_PATH, seed, { mode: 0o600 });
  }

  try {
    const dfOut = execSafe("df", ["-BG", "--output=avail", homedir()], { silent: true });
    const match = dfOut.match(/(\d+)G/);
    if (match) {
      const freeGB = parseInt(match[1]);
      if (freeGB < 1) {
        logger.fail(`Disk: ${freeGB} GB free (need >= 1 GB)`);
        throw new Error("Insufficient disk space");
      }
      logger.ok(`Disk: ${freeGB} GB free`);
    }
  } catch {}

  if (opts.provider === "amazon-bedrock") {
    const hasAws =
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      await fileExists(resolve(homedir(), ".aws", "credentials")) ||
      await fileExists(resolve(homedir(), ".aws", "config"));

    let hasInstanceRole = false;
    if (!hasAws) {
      try {
        const result = execSafe("curl", ["-sf", "--max-time", "2",
          "http://169.254.169.254/latest/meta-data/iam/security-credentials/"], { silent: true });
        hasInstanceRole = result.length > 0;
      } catch {}
    }

    if (hasAws) {
      logger.ok("AWS credentials found");
    } else if (hasInstanceRole) {
      logger.ok("AWS credentials found (instance IAM role)");
    } else {
      logger.warn("AWS credentials not found — configure before first use");
    }
  }

  try {
    const resolved = await realpath(opts.cwd);
    const st = await stat(resolved);
    if (!st.isDirectory()) throw new Error("not a directory");
    opts.cwd = resolved;
    logger.ok(`Working directory: ${resolved.replace(homedir(), "~")}`);
  } catch {
    logger.fail(`--cwd path invalid: ${opts.cwd}`);
    throw new Error(`Invalid --cwd: ${opts.cwd}`);
  }
}

export async function stepValidateToken(logger: StepLog, opts: SetupOptions): Promise<BotInfo> {
  logger.step("②", "Validating Telegram bot token...");

  const botInfo = await validateBotToken(opts.botToken);
  logger.ok(`Bot: @${botInfo.username} (id: ${botInfo.id})`);

  const webhook = await checkWebhook(opts.botToken);
  if (webhook) {
    logger.warn(`Webhook active: ${webhook}`);
    logger.warn("Polling won't work while a webhook is set. Remove it or switch to webhook mode.");
  }

  return botInfo;
}

export async function stepStopGateway(logger: StepLog): Promise<void> {
  logger.step("④", "Checking for running gateway...");

  if (platform() === "darwin") {
    try {
      const { isLaunchAgentRunning, PLIST_PATH } = await import("../launchd.ts");
      if (isLaunchAgentRunning()) {
        logger.log("   Stopping existing LaunchAgent...");
        execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
        logger.ok("LaunchAgent stopped");
      } else {
        logger.ok("No running gateway");
      }
    } catch {
      logger.ok("No running gateway");
    }
    return;
  }

  if (platform() !== "linux") {
    logger.ok("Skipped (not Linux or macOS)");
    return;
  }
  if (isServiceActive()) {
    logger.log("   Stopping existing gateway...");
    try {
      systemctl("stop");
      logger.ok("Service stopped");
    } catch {
      logger.warn("Could not stop service (may need sudo). Continuing anyway.");
    }
  } else {
    logger.ok("No running gateway");
  }
}

async function installAgentPackages(logger: StepLog, opts: SetupOptions, agent: AgentDefinition): Promise<void> {
  if (opts._skipAgentInstall) {
    logger.ok("Agent already configured — skipping package install");
    return;
  }

  for (const pkg of agent.packages) {
    const label = pkg.name ?? pkg.packageName;
    const installed = pkg.binary ? whichSync(pkg.binary) : false;
    if (installed && !opts.force) {
      logger.ok(`${label} (already installed)`);
    } else {
      logger.log(`   Installing ${label}...`);
      const args = pkg.install === "global"
        ? ["install", "-g", pkg.packageName]
        : ["install", pkg.packageName];
      execOrFail("npm", args, `${label} install`);
      logger.ok(label);
    }
  }
}

async function installPsst(logger: StepLog, opts: SetupOptions, agent: AgentDefinition): Promise<void> {
  if (!opts.psst) return;

  if (!whichSync("bun")) {
    logger.log("   Installing bun runtime (required by psst)...");
    try {
      execFileSync("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"], {
        encoding: "utf8", stdio: "pipe", timeout: 120_000,
        env: { ...process.env, HOME: homedir() },
      });
      const bunPath = resolve(homedir(), ".bun", "bin");
      process.env.PATH = `${bunPath}:${process.env.PATH}`;
      logger.ok("bun runtime");
    } catch (err: any) {
      logger.warn(`bun install failed: ${err.message}`);
      logger.warn("psst requires bun — install manually: curl -fsSL https://bun.sh/install | bash");
      opts.psst = false;
      return;
    }
  } else {
    logger.ok("bun runtime (already installed)");
  }

  const psstInstalled = whichSync("psst");
  if (psstInstalled && !opts.force) {
    logger.ok(`psst-cli (already installed)`);
  } else {
    logger.log("   Installing psst-cli...");
    try {
      execFileSync("npm", ["install", "-g", "psst-cli"], {
        encoding: "utf8", stdio: "pipe", timeout: 120_000,
      });
    } catch {}
    if (whichSync("psst")) {
      logger.ok("psst-cli");
    } else {
      logger.warn("psst-cli install failed");
      opts.psst = false;
      return;
    }
  }

  const vaultExists = await fileExists(resolve(homedir(), ".psst", "envs"));
  if (vaultExists) {
    logger.ok("psst vault exists");
  } else {
    logger.log("   Initializing psst vault...");
    const psstEnv = { ...process.env };
    if (!psstEnv.PSST_PASSWORD) {
      const psstPw = randomBytes(32).toString("base64");
      const pwFile = resolve(ROUNDHOUSE_DIR, ".psst-password");
      await atomicWriteText(pwFile, psstPw + "\n", 0o600);
      psstEnv.PSST_PASSWORD = psstPw;
      process.env.PSST_PASSWORD = psstPw;
    }
    try {
      execFileSync("psst", ["init"], {
        encoding: "utf8", stdio: "pipe", timeout: 30_000,
        env: psstEnv,
      });
      logger.ok("psst vault initialized");
    } catch (err: any) {
      logger.warn(`psst vault init failed: ${err.stderr?.trim() || err.message}`);
      try { await unlink(resolve(ROUNDHOUSE_DIR, ".psst-password")); } catch {}
      delete process.env.PSST_PASSWORD;
      opts.psst = false;
      return;
    }
  }

  if (agent.installExtension) {
    logger.log("   Installing agent psst extension...");
    try {
      await agent.installExtension("@miclivs/pi-psst");
      logger.ok("@miclivs/pi-psst extension");
    } catch {
      logger.ok("@miclivs/pi-psst extension (already installed)");
    }
  }
}

async function installUserExtensions(logger: StepLog, opts: SetupOptions, agent: AgentDefinition): Promise<void> {
  for (const ext of opts.extensions) {
    if (!agent.installExtension) {
      logger.fail(`--extension is not supported for agent "${agent.type}"`);
      throw new Error(`Agent "${agent.type}" does not support extensions`);
    }
    logger.log(`   Installing extension: ${ext}...`);
    await agent.installExtension(ext);
    logger.ok(ext);
  }
}

export async function stepInstallPackages(logger: StepLog, opts: SetupOptions, agent: AgentDefinition): Promise<void> {
  logger.step("⑤", "Installing packages...");

  const rhInstalled = whichSync("roundhouse");
  if (rhInstalled && !opts.force) {
    logger.ok(`@inceptionstack/roundhouse (already installed)`);
  } else {
    logger.log("   Installing @inceptionstack/roundhouse...");
    execOrFail("npm", ["install", "-g", "@inceptionstack/roundhouse"], "roundhouse install");
    logger.ok("@inceptionstack/roundhouse");
  }

  await installAgentPackages(logger, opts, agent);
  await installPsst(logger, opts, agent);
  await installUserExtensions(logger, opts, agent);
}

export async function stepStoreSecrets(logger: StepLog, opts: SetupOptions, botInfo: BotInfo): Promise<void> {
  if (!opts.psst) {
    logger.step("⑧", "Storing secrets...");
    logger.ok("Skipped (default — use --with-psst to enable)");
    return;
  }

  logger.step("⑧", "Storing secrets in psst...");

  const secrets: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN", opts.botToken],
    ["BOT_USERNAME", botInfo.username],
    ["ALLOWED_USERS", opts.users.join(",")],
  ];

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

export async function stepInstallBundle(logger: StepLog, opts: SetupOptions): Promise<void> {
  logger.step("⑥", "Installing bundle (skills + CLI tools)...");

  const bundleLog: ProvisionLog = {
    info: (msg) => logger.log(`   ${msg}`),
    warn: (msg) => logger.warn(msg),
    ok: (msg) => logger.ok(msg),
  };

  provisionBundle({ force: opts.force, log: bundleLog });
}

export async function stepConfigure(
  logger: StepLog,
  opts: SetupOptions,
  botInfo: BotInfo,
  pairResult: PairResult | null,
  agent: AgentDefinition,
): Promise<void> {
  logger.step("⑨", "Configuring...");

  await mkdir(ROUNDHOUSE_DIR, { recursive: true });

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
    try {
      gatewayConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch {}
  }

  const existingUsers: string[] = gatewayConfig.chat?.allowedUsers ?? [];
  const existingUserIds: number[] = gatewayConfig.chat?.allowedUserIds ?? [];
  const existingNotifyIds: number[] = (gatewayConfig.chat?.notifyChatIds ?? []).map(Number).filter((n) => !isNaN(n));

  const mergedUsers = [...new Set([...existingUsers, ...opts.users])];
  const mergedUserIds = [...existingUserIds];
  const mergedNotifyIds = [...new Set([...existingNotifyIds, ...opts.notifyChatIds])];

  if (pairResult) {
    if (!mergedUserIds.includes(pairResult.userId)) {
      mergedUserIds.push(pairResult.userId);
    }
    if (!mergedNotifyIds.includes(pairResult.chatId)) {
      mergedNotifyIds.push(pairResult.chatId);
    }
  }

  gatewayConfig = {
    ...gatewayConfig,
    _version: 1,
    agent: { ...gatewayConfig.agent, ...agent.configDefaults, type: agent.type, cwd: opts.cwd },
    chat: {
      ...gatewayConfig.chat,
      botUsername: botInfo.username,
      allowedUsers: mergedUsers,
      allowedUserIds: mergedUserIds,
      notifyChatIds: mergedNotifyIds,
      adapters: gatewayConfig.chat?.adapters ?? { telegram: { mode: "polling" } },
    },
    ...(opts.voice === false ? { voice: { stt: { enabled: false } } } : {}),
  };

  await atomicWriteJson(CONFIG_PATH, gatewayConfig);
  logger.ok(`~/.roundhouse/gateway.config.json`);

  const envLines: string[] = [];

  if (!opts.psst) {
    envLines.push(`TELEGRAM_BOT_TOKEN=${envQuote(opts.botToken)}`);
    envLines.push(`BOT_USERNAME=${envQuote(botInfo.username)}`);
    envLines.push(`ALLOWED_USERS=${envQuote(opts.users.join(","))}`);
  }

  if (opts.psst) {
    const pwFile = resolve(ROUNDHOUSE_DIR, ".psst-password");
    if (await fileExists(pwFile)) {
      const pw = (await readFile(pwFile, "utf8")).trim();
      envLines.push(`PSST_PASSWORD=${envQuote(pw)}`);
    }
  }

  if (opts.provider === "amazon-bedrock") {
    let existingEnv = new Map<string, string>();
    try {
      existingEnv = parseEnvFile(await readFile(ENV_PATH, "utf8"));
    } catch {}
    const getExisting = (key: string) => existingEnv.get(key);

    if (!envLines.some((l) => l.startsWith("AWS_PROFILE="))) {
      envLines.push(`AWS_PROFILE=${getExisting("AWS_PROFILE") ?? '"default"'}`);
    }
    if (!envLines.some((l) => l.startsWith("AWS_DEFAULT_REGION="))) {
      envLines.push(`AWS_DEFAULT_REGION=${getExisting("AWS_DEFAULT_REGION") ?? '"us-east-1"'}`);
    }
    if (!envLines.some((l) => l.startsWith("AWS_REGION="))) {
      envLines.push(`AWS_REGION=${getExisting("AWS_REGION") ?? getExisting("AWS_DEFAULT_REGION") ?? '"us-east-1"'}`);
    }
  }

  await atomicWriteText(ENV_PATH, envLines.join("\n") + "\n");
  logger.ok(`~/.roundhouse/.env${opts.psst ? " (non-secret config only)" : ""}`);
}

export async function stepPair(logger: StepLog, opts: SetupOptions, botInfo: BotInfo): Promise<PairResult | null> {
  logger.step("⑦", "Pairing with Telegram...");

  if (opts.notifyChatIds.length > 0) {
    logger.ok(`Using provided notify chat IDs: ${opts.notifyChatIds.join(", ")}`);

    for (const chatId of opts.notifyChatIds) {
      try {
        await sendMessage(opts.botToken, chatId, "✅ Roundhouse setup complete! Gateway is starting.");
        logger.ok(`Sent test message to chat ${chatId}`);
      } catch {
        logger.warn(`Could not send message to chat ${chatId}`);
      }
    }
    return null;
  }

  if (!opts.force) {
    try {
      const existing = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      const existingIds = existing.chat?.notifyChatIds ?? [];
      if (existingIds.length > 0) {
        logger.ok(`Already paired (chat IDs: ${existingIds.join(", ")})`);
        return null;
      }
    } catch {}
  }

  if (opts.nonInteractive) {
    logger.warn("Skipping pairing (--non-interactive)");
    logger.warn("Startup notifications won't work until paired.");
    logger.warn("Run 'roundhouse pair' later to pair.");
    return null;
  }

  const result = await pairTelegram(opts.botToken, botInfo.username, opts.users, 300_000, logger.log);

  if (result) {
    logger.ok(`Paired with @${result.username} (user id: ${result.userId}, chat: ${result.chatId})`);
    const lcUsername = result.username.toLowerCase();
    if (!opts.users.some((u) => u.toLowerCase() === lcUsername)) {
      opts.users.push(result.username);
    }
    return result;
  }

  logger.warn("Pairing timed out.");
  logger.warn("Run 'roundhouse pair' later to pair.");
  return null;
}

export async function stepRegisterCommands(logger: StepLog, opts: SetupOptions): Promise<void> {
  logger.step("⑩", "Registering bot commands...");
  await registerBotCommands(opts.botToken);
  logger.ok(`${BOT_COMMANDS.length} commands registered with Telegram`);
}

export async function stepInstallSystemd(logger: StepLog, opts: SetupOptions): Promise<void> {
  logger.step("⑩b", "Installing service...");

  if (platform() === "darwin") {
    try {
      const { installLaunchAgent } = await import("../launchd.ts");
      await installLaunchAgent();
      logger.ok("LaunchAgent installed and loaded");
      logger.log("   Logs: ~/.roundhouse/logs/roundhouse.log");
    } catch (err: any) {
      logger.warn(`LaunchAgent install failed: ${err.message}`);
      logger.log("   Run manually: roundhouse start");
    }
    return;
  }

  if (!opts.systemd) {
    logger.ok("Skipped (--no-systemd)");
    logger.log("   Run manually: roundhouse start");
    return;
  }
  if (platform() !== "linux") {
    logger.warn(`Service install not supported on ${platform()}`);
    logger.log("   Run manually: roundhouse start");
    return;
  }

  if (!hasSudoAccess()) {
    logger.warn("No passwordless sudo — cannot install systemd service");
    logger.log("   Run manually: roundhouse start");
    logger.log("   Or install with: roundhouse setup --telegram");
    return;
  }

  const user = process.env.USER || process.env.LOGNAME;
  if (!user) {
    logger.warn("Cannot determine current user ($USER not set). Skipping systemd.");
    logger.log("   Run manually: roundhouse start");
    return;
  }

  const psstBin = opts.psst ? whichSync("psst") : null;
  const { execStart, nodeBinDir } = resolveExecStart({ psstBin });
  const unit = generateUnit({ execStart, nodeBinDir, user });

  try {
    await writeServiceUnit(unit);
    systemctl("enable");
    systemctl("start");
    logger.ok("roundhouse.service enabled and started");
  } catch (err: any) {
    logger.warn(`Systemd install failed: ${err.message}`);
    logger.log("   Run manually: roundhouse start");
  }
}

export async function stepPostflight(logger: StepLog): Promise<void> {
  logger.step("⑪", "Postflight checks...");

  if (platform() === "linux") {
    if (isServiceActive()) {
      const pid = systemctlShow("MainPID");
      logger.ok(`Service active (PID ${pid})`);
    } else {
      logger.warn("Service not active — check: roundhouse logs");
    }
  }

  if (await fileExists(CONFIG_PATH)) {
    logger.ok("Config readable");
  } else {
    logger.warn(`Config missing: ${CONFIG_PATH}`);
  }

  if (!whichSync("ffmpeg")) {
    logger.warn("ffmpeg not found (install for voice support)");
  }

  if (platform() === "linux" || process.env.ROUNDHOUSE_VOICE === "1") {
    if (!whichSync("whisper")) {
      logger.warn("whisper not found — STT will auto-install on first voice message");
      logger.log("    Pre-install: pip3 install openai-whisper");
    } else {
      logger.ok("whisper available");
    }
  }

  if (!process.env.TAVILY_API_KEY) {
    logger.warn("TAVILY_API_KEY not set — web search extension won't work");
    logger.log("    Get a free key at https://tavily.com and add to ~/.roundhouse/.env");
  }
}

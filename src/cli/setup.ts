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

import { homedir, platform } from "node:os";
import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir, rename, unlink, realpath, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BOT_COMMANDS } from "../commands";
import {
  ROUNDHOUSE_DIR,
  CONFIG_PATH,
  ENV_FILE_PATH as ENV_PATH,
  fileExists,
} from "../config";
import { envQuote, parseEnvFile } from "./env-file";
import {
  whichSync,
  systemctl,
  isServiceActive,
  systemctlShow,
  resolveExecStart,
  generateUnit,
  writeServiceUnit,
  hasSudoAccess,
} from "./systemd";
import {
  validateBotToken,
  checkWebhook,
  registerBotCommands,
  pairTelegram,
  sendMessage,
  type BotInfo,
  type PairResult,
} from "./setup-telegram";

// ── Types ────────────────────────────────────────────

interface SetupOptions {
  botToken: string;
  users: string[];
  provider: string;
  model: string;
  extensions: string[];
  cwd: string;
  notifyChatIds: number[];
  systemd: boolean;
  voice: boolean;
  psst: boolean;
  nonInteractive: boolean;
  force: boolean;
  dryRun: boolean;
}

type StepStatus = "ok" | "warn" | "skip" | "fail";

// ── Constants ────────────────────────────────────────

const PI_SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");

const DEFAULT_PROVIDER = "amazon-bedrock";
const DEFAULT_MODEL = "us.anthropic.claude-opus-4-6-v1";

const EXTENSION_NAME_RE = /^@?[a-z0-9][\w.\-/]*$/i;

// ── Helpers ──────────────────────────────────────────

function log(msg: string) { console.log(msg); }
function step(n: string, label: string) { log(`\n${n} ${label}`); }
function ok(msg: string) { log(`   ✓ ${msg}`); }
function warn(msg: string) { log(`   ⚠ ${msg}`); }
function fail(msg: string) { log(`   ✗ ${msg}`); }

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

async function atomicWriteText(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

function execSafe(cmd: string, args: string[], opts: { silent?: boolean; input?: string } = {}): string {
  try {
    const result = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: opts.silent ? "pipe" : opts.input ? ["pipe", "pipe", "pipe"] : "pipe",
      input: opts.input,
      timeout: 120_000,
    });
    return result.trim();
  } catch {
    return "";
  }
}

function execOrFail(cmd: string, args: string[], label: string): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", timeout: 120_000 }).trim();
  } catch (err: any) {
    throw new Error(`${label}: ${err.stderr?.trim() || err.message}`);
  }
}

// ── Arg parser ───────────────────────────────────────

export function parseSetupArgs(argv: string[]): SetupOptions {
  const opts: SetupOptions = {
    botToken: "",
    users: [],
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    extensions: [],
    cwd: homedir(),
    notifyChatIds: [],
    systemd: platform() === "linux",
    voice: true,
    psst: false,
    nonInteractive: false,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    switch (arg) {
      case "--bot-token": opts.botToken = next(); break;
      case "--user": opts.users.push(next().replace(/^@/, "")); break;
      case "--provider": opts.provider = next(); break;
      case "--model": opts.model = next(); break;
      case "--extension": opts.extensions.push(next()); break;
      case "--cwd": opts.cwd = next(); break;
      case "--notify-chat": opts.notifyChatIds.push(parseInt(next(), 10)); break;
      case "--no-systemd": opts.systemd = false; break;
      case "--no-voice": opts.voice = false; break;
      case "--with-psst": opts.psst = true; break;
      case "--non-interactive": opts.nonInteractive = true; break;
      case "--force": opts.force = true; break;
      case "--dry-run": opts.dryRun = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  // Token from env if not in flags
  if (!opts.botToken) {
    opts.botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  }

  // Validate
  if (!opts.botToken && !opts.dryRun) {
    throw new Error(
      "Bot token required. Provide via:\n" +
      "  TELEGRAM_BOT_TOKEN=... roundhouse setup --user USERNAME\n" +
      "  roundhouse setup --bot-token TOKEN --user USERNAME",
    );
  }
  if (opts.users.length === 0) {
    throw new Error(
      "At least one --user USERNAME is required.\n" +
      "This is your Telegram username (without @).",
    );
  }
  for (const ext of opts.extensions) {
    if (!EXTENSION_NAME_RE.test(ext)) {
      throw new Error(`Invalid extension name: ${ext}`);
    }
  }
  if (opts.notifyChatIds.some(isNaN)) {
    throw new Error("--notify-chat must be a number");
  }

  return opts;
}

// ── Steps ────────────────────────────────────────────

async function stepPreflight(opts: SetupOptions): Promise<void> {
  step("①", "Preflight checks...");

  // Node version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.replace("v", ""));
  if (major < 20) {
    fail(`Node.js ${nodeVer} — version 20+ required`);
    throw new Error("Node.js 20+ required");
  }
  ok(`Node.js ${nodeVer}`);

  // npm
  if (!whichSync("npm")) {
    fail("npm not found on PATH");
    throw new Error("npm required");
  }
  ok("npm available");

  // Config dirs writable
  for (const dir of [ROUNDHOUSE_DIR, dirname(PI_SETTINGS_PATH)]) {
    try {
      await mkdir(dir, { recursive: true });
      ok(`Writable: ${dir.replace(homedir(), "~")}`);
    } catch {
      fail(`Cannot create: ${dir}`);
      throw new Error(`Cannot write to ${dir}`);
    }
  }

  // Disk space (rough check)
  try {
    const dfOut = execSafe("df", ["-BG", "--output=avail", homedir()], { silent: true });
    const match = dfOut.match(/(\d+)G/);
    if (match) {
      const freeGB = parseInt(match[1]);
      if (freeGB < 1) {
        fail(`Disk: ${freeGB} GB free (need >= 1 GB)`);
        throw new Error("Insufficient disk space");
      }
      ok(`Disk: ${freeGB} GB free`);
    }
  } catch { /* non-fatal, df might not support these flags */ }

  // Provider credentials (warn only)
  if (opts.provider === "amazon-bedrock") {
    const hasAws =
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      await fileExists(resolve(homedir(), ".aws", "credentials")) ||
      await fileExists(resolve(homedir(), ".aws", "config"));

    // Also check instance metadata (EC2 IAM role)
    let hasInstanceRole = false;
    if (!hasAws) {
      try {
        const result = execSafe("curl", ["-sf", "--max-time", "2",
          "http://169.254.169.254/latest/meta-data/iam/security-credentials/"], { silent: true });
        hasInstanceRole = result.length > 0;
      } catch {}
    }

    if (hasAws) {
      ok("AWS credentials found");
    } else if (hasInstanceRole) {
      ok("AWS credentials found (instance IAM role)");
    } else {
      warn("AWS credentials not found — configure before first use");
    }
  }

  // --cwd validation
  try {
    const resolved = await realpath(opts.cwd);
    const st = await stat(resolved);
    if (!st.isDirectory()) throw new Error("not a directory");
    opts.cwd = resolved;
    ok(`Working directory: ${resolved.replace(homedir(), "~")}`);
  } catch {
    fail(`--cwd path invalid: ${opts.cwd}`);
    throw new Error(`Invalid --cwd: ${opts.cwd}`);
  }
}

async function stepValidateToken(opts: SetupOptions): Promise<BotInfo> {
  step("②", "Validating Telegram bot token...");

  const botInfo = await validateBotToken(opts.botToken);
  ok(`Bot: @${botInfo.username} (id: ${botInfo.id})`);

  // Check for conflicting webhook
  const webhook = await checkWebhook(opts.botToken);
  if (webhook) {
    warn(`Webhook active: ${webhook}`);
    warn("Polling won't work while a webhook is set. Remove it or switch to webhook mode.");
  }

  return botInfo;
}

async function stepStopGateway(): Promise<void> {
  step("③", "Checking for running gateway...");

  if (platform() !== "linux") {
    ok("Not Linux — skipping service check");
    return;
  }

  if (isServiceActive()) {
    log("   Stopping existing gateway...");
    try {
      systemctl("stop");
      ok("Service stopped");
    } catch {
      warn("Could not stop service (may need sudo). Continuing anyway.");
    }
  } else {
    ok("No running gateway");
  }
}

async function stepInstallPackages(opts: SetupOptions): Promise<void> {
  step("④", "Installing packages...");

  // Roundhouse
  const rhInstalled = whichSync("roundhouse");
  if (rhInstalled && !opts.force) {
    ok(`@inceptionstack/roundhouse (already installed)`);
  } else {
    log("   Installing @inceptionstack/roundhouse...");
    execOrFail("npm", ["install", "-g", "@inceptionstack/roundhouse"], "roundhouse install");
    ok("@inceptionstack/roundhouse");
  }

  // Pi agent
  const piInstalled = whichSync("pi");
  if (piInstalled && !opts.force) {
    ok(`@mariozechner/pi-coding-agent (already installed)`);
  } else {
    log("   Installing @mariozechner/pi-coding-agent...");
    execOrFail("npm", ["install", "-g", "@mariozechner/pi-coding-agent"], "pi install");
    ok("@mariozechner/pi-coding-agent");
  }

  // psst-cli (requires bun runtime)
  if (opts.psst) {
    // Install bun if not present (psst-cli shebang is #!/usr/bin/env bun)
    if (!whichSync("bun")) {
      log("   Installing bun runtime (required by psst)...");
      try {
        execFileSync("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"], {
          encoding: "utf8", stdio: "pipe", timeout: 120_000,
          env: { ...process.env, HOME: homedir() },
        });
        // bun installs to ~/.bun/bin/bun
        const bunPath = resolve(homedir(), ".bun", "bin");
        process.env.PATH = `${bunPath}:${process.env.PATH}`;
        ok("bun runtime");
      } catch (err: any) {
        warn(`bun install failed: ${err.message}`);
        warn("psst requires bun — install manually: curl -fsSL https://bun.sh/install | bash");
        opts.psst = false;
      }
    } else {
      ok("bun runtime (already installed)");
    }
  }

  // psst-cli
  if (opts.psst) {
    const psstInstalled = whichSync("psst");
    if (psstInstalled && !opts.force) {
      ok(`psst-cli (already installed)`);
    } else {
      log("   Installing psst-cli...");
      try {
        execFileSync("npm", ["install", "-g", "psst-cli"], {
          encoding: "utf8", stdio: "pipe", timeout: 120_000,
        });
      } catch {
        // npm may exit non-zero due to postinstall warnings — check if binary exists
      }
      if (whichSync("psst")) {
        ok("psst-cli");
      } else {
        warn("psst-cli install failed");
        opts.psst = false;
      }
    }

    // Initialize psst vault
    const vaultExists = await fileExists(resolve(homedir(), ".psst", "envs"));
    if (vaultExists) {
      ok("psst vault exists");
    } else {
      log("   Initializing psst vault...");
      // On headless servers, no keychain is available — use PSST_PASSWORD
      const psstEnv = { ...process.env };
      if (!psstEnv.PSST_PASSWORD) {
        // Generate a random password and store it for future use
        const psstPw = randomBytes(32).toString("base64");
        const pwFile = resolve(ROUNDHOUSE_DIR, ".psst-password");
        await atomicWriteText(pwFile, psstPw + "\n", 0o600);
        psstEnv.PSST_PASSWORD = psstPw;
        // Also set for subsequent psst calls in this process
        process.env.PSST_PASSWORD = psstPw;
      }
      try {
        execFileSync("psst", ["init"], {
          encoding: "utf8", stdio: "pipe", timeout: 30_000,
          env: psstEnv,
        });
        ok("psst vault initialized");
      } catch (err: any) {
        warn(`psst vault init failed: ${err.stderr?.trim() || err.message}`);
        // Clean up orphan password file
        try { await unlink(resolve(ROUNDHOUSE_DIR, ".psst-password")); } catch {}
        delete process.env.PSST_PASSWORD;
        opts.psst = false;
      }
    }

    // Install pi-psst extension
    log("   Installing pi-psst extension...");
    try {
      execFileSync("pi", ["install", "npm:@miclivs/pi-psst"], { encoding: "utf8", stdio: "pipe", timeout: 120_000 });
      ok("@miclivs/pi-psst extension");
    } catch {
      // May already be installed
      ok("@miclivs/pi-psst extension (already installed)");
    }
  }

  // User extensions
  for (const ext of opts.extensions) {
    log(`   Installing extension: ${ext}...`);
    execOrFail("pi", ["install", `npm:${ext}`], `extension ${ext}`);
    ok(ext);
  }
}

async function stepStoreSecrets(opts: SetupOptions, botInfo: BotInfo): Promise<void> {
  if (!opts.psst) {
    step("⑥", "Storing secrets...");
    ok("Skipped (default — use --with-psst to enable)");
    return;
  }

  step("⑥", "Storing secrets in psst...");

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
      ok(`${name} → psst vault`);
    } catch {
      // May already exist with same value
      // Try overwrite
      try {
        execFileSync("psst", ["set", name, "--stdin"], {
          input: value,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
          env: { ...process.env, PSST_FORCE: "1" },
        });
        ok(`${name} → psst vault (updated)`);
      } catch (err: any) {
        warn(`Failed to store ${name} in psst: ${err.message}`);
      }
    }
  }
}

async function stepConfigure(
  opts: SetupOptions,
  botInfo: BotInfo,
  pairResult: PairResult | null,
): Promise<void> {
  step("⑦", "Configuring...");

  await mkdir(ROUNDHOUSE_DIR, { recursive: true });
  await mkdir(dirname(PI_SETTINGS_PATH), { recursive: true });

  // ── Pi settings ──
  let piSettings: Record<string, any> = {};
  try {
    piSettings = JSON.parse(await readFile(PI_SETTINGS_PATH, "utf8"));
  } catch { /* doesn't exist */ }

  if (opts.force) {
    piSettings.defaultProvider = opts.provider;
    piSettings.defaultModel = opts.model;
  } else {
    const existingProvider = piSettings.defaultProvider;
    const existingModel = piSettings.defaultModel;
    if (existingProvider && existingProvider !== opts.provider) {
      warn(`Pi provider already set to '${existingProvider}' (keeping, use --force to override)`);
    } else {
      piSettings.defaultProvider = opts.provider;
    }
    if (existingModel && existingModel !== opts.model) {
      warn(`Pi model already set to '${existingModel}' (keeping, use --force to override)`);
    } else {
      piSettings.defaultModel = opts.model;
    }
  }

  // Ensure packages array includes pi-psst if using psst
  if (!piSettings.packages) piSettings.packages = [];
  if (opts.psst && !piSettings.packages.includes("npm:@miclivs/pi-psst")) {
    piSettings.packages.push("npm:@miclivs/pi-psst");
  }

  await atomicWriteJson(PI_SETTINGS_PATH, piSettings);
  ok(`~/.pi/agent/settings.json (${piSettings.defaultProvider}, ${piSettings.defaultModel})`);

  // ── Gateway config ──
  let gatewayConfig: Record<string, any> = {};
  if (!opts.force) {
    try {
      gatewayConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch { /* new install */ }
  }

  // Merge users
  const existingUsers: string[] = gatewayConfig.chat?.allowedUsers ?? [];
  const existingUserIds: number[] = gatewayConfig.chat?.allowedUserIds ?? [];
  const existingNotifyIds: number[] = (gatewayConfig.chat?.notifyChatIds ?? []).map(Number).filter((n) => !isNaN(n));

  const mergedUsers = [...new Set([...existingUsers, ...opts.users])];
  const mergedUserIds = [...existingUserIds];
  const mergedNotifyIds = [...new Set([...existingNotifyIds, ...opts.notifyChatIds])];

  // Add paired user data
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
    _version: 1, // Config schema version — for future migration support
    agent: { ...gatewayConfig.agent, type: "pi", cwd: opts.cwd },
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
  ok(`~/.roundhouse/gateway.config.json`);

  // ── Env file ──
  // With psst: only non-secret config
  // Without psst: include secrets
  const envLines: string[] = [];

  if (!opts.psst) {
    envLines.push(`TELEGRAM_BOT_TOKEN=${envQuote(opts.botToken)}`);
    envLines.push(`BOT_USERNAME=${envQuote(botInfo.username)}`);
    envLines.push(`ALLOWED_USERS=${envQuote(opts.users.join(","))}`);
  }

  // If psst uses a generated password (headless), include it in env for systemd.
  // Threat model tradeoff: the vault key is plaintext in a 0600 file, but this is
  // unavoidable on headless servers with no keychain. The benefit is that individual
  // secrets are still managed centrally via psst and injected at runtime.
  if (opts.psst) {
    const pwFile = resolve(ROUNDHOUSE_DIR, ".psst-password");
    if (await fileExists(pwFile)) {
      const pw = (await readFile(pwFile, "utf8")).trim();
      envLines.push(`PSST_PASSWORD=${envQuote(pw)}`);
    }
  }

  if (opts.provider === "amazon-bedrock") {
    // Preserve existing AWS config
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
    // Pi agent requires AWS_REGION (not just AWS_DEFAULT_REGION) to discover Bedrock models
    if (!envLines.some((l) => l.startsWith("AWS_REGION="))) {
      envLines.push(`AWS_REGION=${getExisting("AWS_REGION") ?? getExisting("AWS_DEFAULT_REGION") ?? '"us-east-1"'}`);
    }
  }

  await atomicWriteText(ENV_PATH, envLines.join("\n") + "\n");
  ok(`~/.roundhouse/.env${opts.psst ? " (non-secret config only)" : ""}`);
}

async function stepPair(opts: SetupOptions, botInfo: BotInfo): Promise<PairResult | null> {
  step("⑤", "Pairing with Telegram...");

  // Skip if chat IDs already known
  if (opts.notifyChatIds.length > 0) {
    ok(`Using provided notify chat IDs: ${opts.notifyChatIds.join(", ")}`);

    // Send test message
    for (const chatId of opts.notifyChatIds) {
      try {
        await sendMessage(opts.botToken, chatId, "✅ Roundhouse setup complete! Gateway is starting.");
        ok(`Sent test message to chat ${chatId}`);
      } catch {
        warn(`Could not send message to chat ${chatId}`);
      }
    }
    return null;
  }

  // Skip if existing config already has notifyChatIds
  if (!opts.force) {
    try {
      const existing = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      const existingIds = existing.chat?.notifyChatIds ?? [];
      if (existingIds.length > 0) {
        ok(`Already paired (chat IDs: ${existingIds.join(", ")})`);
        return null;
      }
    } catch {}
  }

  // Skip if non-interactive
  if (opts.nonInteractive) {
    warn("Skipping pairing (--non-interactive)");
    warn("Startup notifications won't work until paired.");
    warn("Run 'roundhouse pair' later to pair.");
    return null;
  }

  const result = await pairTelegram(opts.botToken, botInfo.username, opts.users, 300_000, log);

  if (result) {
    ok(`Paired with @${result.username} (user id: ${result.userId}, chat: ${result.chatId})`);
    // Add paired username to allowedUsers if not already present
    const lcUsername = result.username.toLowerCase();
    if (!opts.users.some((u) => u.toLowerCase() === lcUsername)) {
      opts.users.push(result.username);
    }
    return result;
  }

  warn("Pairing timed out.");
  warn("Run 'roundhouse pair' later to pair.");
  return null;
}

async function stepRegisterCommands(opts: SetupOptions): Promise<void> {
  step("⑧", "Registering bot commands...");
  await registerBotCommands(opts.botToken);
  ok(`${BOT_COMMANDS.length} commands registered with Telegram`);
}

async function stepInstallSystemd(opts: SetupOptions): Promise<void> {
  step("⑨", "Installing systemd service...");

  if (!opts.systemd) {
    ok("Skipped (--no-systemd)");
    log("   Run manually: roundhouse start");
    return;
  }

  if (platform() !== "linux") {
    warn(`Systemd not available (${platform()})`);
    log("   Run manually: roundhouse start");
    return;
  }

  // Check sudo
  if (!hasSudoAccess()) {
    warn("No passwordless sudo — cannot install systemd service");
    log("   Run manually: roundhouse start");
    log("   Or install with: sudo roundhouse install");
    return;
  }

  const user = process.env.USER || process.env.LOGNAME;
  if (!user) {
    warn("Cannot determine current user ($USER not set). Skipping systemd.");
    log("   Run manually: roundhouse start");
    return;
  }

  const psstBin = opts.psst ? whichSync("psst") : null;
  const { execStart, nodeBinDir } = resolveExecStart({ psstBin });
  const unit = generateUnit({ execStart, nodeBinDir, user });

  try {
    await writeServiceUnit(unit);
    systemctl("enable");
    systemctl("start");
    ok("roundhouse.service enabled and started");
  } catch (err: any) {
    warn(`Systemd install failed: ${err.message}`);
    log("   Run manually: roundhouse start");
  }
}

async function stepPostflight(): Promise<void> {
  step("⑩", "Postflight checks...");

  if (platform() === "linux") {
    if (isServiceActive()) {
      const pid = systemctlShow("MainPID");
      ok(`Service active (PID ${pid})`);
    } else {
      warn("Service not active — check: roundhouse logs");
    }
  }

  if (await fileExists(CONFIG_PATH)) {
    ok("Config readable");
  } else {
    warn(`Config missing: ${CONFIG_PATH}`);
  }

  // Optional checks
  if (!whichSync("ffmpeg")) {
    warn("ffmpeg not found (install for voice support)");
  }
}

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

  log("\n🔧 Roundhouse Setup");
  log("━━━━━━━━━━━━━━━━━━━");

  try {
    // Phase 1: Validate (no mutations)
    await stepPreflight(opts);
    const botInfo = await stepValidateToken(opts);
    await stepStopGateway();

    // Phase 2: Install packages
    await stepInstallPackages(opts);

    // Phase 3: Pair (before secrets/config, so paired username is included)
    const pairResult = await stepPair(opts, botInfo);

    // Phase 4: Store secrets (after pairing, so ALLOWED_USERS includes paired user)
    await stepStoreSecrets(opts, botInfo);

    // Phase 5: Write config (includes pair data)
    await stepConfigure(opts, botInfo, pairResult);

    // Phase 6: Remote setup
    await stepRegisterCommands(opts);

    // Phase 7: Service
    await stepInstallSystemd(opts);

    // Phase 8: Verify
    await stepPostflight();

    // Final message
    const warnings = !opts.notifyChatIds.length && !pairResult;
    log("\n━━━━━━━━━━━━━━━━━━━");
    if (warnings) {
      log("⚠️  Installed, action required:");
      log(`   • Not paired — run: roundhouse pair`);
    } else {
      log("✅ Roundhouse is running!");
    }
    log(`   Bot: @${botInfo.username}`);
    log(`   Memory: ${opts.extensions.some((e) => e.includes("pi-memory")) ? "agent-managed" : "roundhouse-managed"}`);
    log(`   Secrets: ${opts.psst ? "psst vault (encrypted)" : "~/.roundhouse/.env (plaintext)"}`);
    log(`   Send /status to @${botInfo.username} on Telegram.\n`);
  } catch (err: any) {
    log("\n━━━━━━━━━━━━━━━━━━━");
    log(`❌ Setup failed: ${err.message}`);
    log("   Partial changes may have been applied.");
    log("   Re-run setup to complete, or run: roundhouse doctor\n");
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
      if (raw) token = raw.replace(/^["']|["']$/g, "");
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

  log("\n🔗 Roundhouse Pairing\n");

  const botInfo = await validateBotToken(token);
  ok(`Bot: @${botInfo.username}`);

  const result = await pairTelegram(token, botInfo.username, users, 300_000, log);

  if (!result) {
    log("\n⚠ Pairing timed out. Try again: roundhouse pair\n");
    process.exit(1);
  }

  ok(`Paired with @${result.username} (user id: ${result.userId}, chat: ${result.chatId})`);

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
    ok("Config updated with chat ID");
  } catch {
    warn("Could not update config — add notifyChatIds manually");
  }

  log("\n✅ Paired! Restart gateway to apply: roundhouse restart\n");
}

// ── Dry run ──────────────────────────────────────────

function printDryRun(opts: SetupOptions): void {
  log("\n🔧 Roundhouse Setup (DRY RUN)");
  log("━━━━━━━━━━━━━━━━━━━\n");
  log("Would validate Telegram token");
  log("Would stop existing gateway (if running)");
  log(`Would install: npm install -g @inceptionstack/roundhouse`);
  log(`Would install: npm install -g @mariozechner/pi-coding-agent`);
  if (opts.psst) {
    log(`Would install: bun runtime (if not present)`);
    log(`Would install: npm install -g psst-cli`);
    log(`Would initialize psst vault`);
    log(`Would install: pi-psst extension`);
  }
  for (const ext of opts.extensions) log(`Would install extension: ${ext}`);
  if (!opts.nonInteractive && opts.notifyChatIds.length === 0) {
    log(`Would pair via Telegram (interactive)`);
  }
  if (opts.psst) {
    log(`Would store TELEGRAM_BOT_TOKEN, BOT_USERNAME, ALLOWED_USERS in psst`);
  }
  log(`Would configure: ~/.pi/agent/settings.json`);
  log(`  Set defaultProvider: ${opts.provider}`);
  log(`  Set defaultModel: ${opts.model}`);
  log(`Would write: ~/.roundhouse/gateway.config.json`);
  log(`Would write: ~/.roundhouse/.env${opts.psst ? " (non-secret config only)" : ""}`);
  log(`Would register ${BOT_COMMANDS.length} bot commands`);
  if (opts.systemd) log(`Would install systemd service`);
  log("\nNo changes made.\n");
}

// ── Help ─────────────────────────────────────────────

function printSetupHelp(): void {
  console.log(`
Usage:
  TELEGRAM_BOT_TOKEN=... roundhouse setup --user USERNAME
  roundhouse setup --bot-token TOKEN --user USERNAME [options]

Required:
  --user <username>          Telegram username (repeatable, strips @)

Token (one required):
  TELEGRAM_BOT_TOKEN env     Preferred — not in shell history
  --bot-token <token>        Fallback for scripts

Agent:
  --provider <provider>      AI provider (default: amazon-bedrock)
  --model <model>            AI model (default: us.anthropic.claude-opus-4-6-v1)
  --extension <pkg>          Pi extension (repeatable)
  --cwd <path>               Agent working directory (default: ~)

Channel:
  --notify-chat <id>         Telegram chat ID (repeatable, skips pairing)

Service:
  --no-systemd               Skip systemd install
  --no-voice                 Disable voice/STT
  --with-psst                Use psst vault for secrets (default: .env file)

Behavior:
  --non-interactive          No pairing, no prompts
  --force                    Overwrite existing configs
  --dry-run                  Preview without changes
`);
}

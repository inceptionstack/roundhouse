/**
 * cli/setup/args.ts — CLI argument parsing for setup command
 */

import { homedir, platform } from "node:os";
import { getAgentDefinition } from "../../agents/registry";
import { type SetupOptions, DEFAULT_PROVIDER, DEFAULT_MODEL, EXTENSION_NAME_RE } from "./types";

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
    voice: platform() === "linux",  // Default off on macOS (whisper install is heavy)
    psst: false,
    nonInteractive: false,
    force: false,
    dryRun: false,
    telegram: false,
    headless: false,
    qr: "auto",
    agent: "pi",
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
      case "--telegram": opts.telegram = true; break;
      case "--headless": opts.headless = true; opts.nonInteractive = true; break;
      case "--agent": opts.agent = next().toLowerCase(); break;
      case "--qr": opts.qr = "always"; break;
      case "--no-qr": opts.qr = "never"; break;
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

  // Headless: reject --bot-token (argv visible in process listings)
  if (opts.headless && argv.some((a) => a === "--bot-token")) {
    throw new Error(
      "--bot-token is not accepted in --headless mode (argv visible in process listings).\n" +
      "Use: TELEGRAM_BOT_TOKEN=... roundhouse setup --telegram --headless --user USERNAME",
    );
  }

  // Validate agent type
  try {
    getAgentDefinition(opts.agent);
  } catch (err: any) {
    throw new Error(err.message);
  }

  // Interactive --telegram defers token/user prompting to the wizard
  const isInteractiveTelegram = opts.telegram && !opts.headless && !opts.nonInteractive && process.stdin.isTTY;

  // Validate
  if (!opts.botToken && !opts.dryRun && !isInteractiveTelegram) {
    throw new Error(
      "Bot token required. Provide via:\n" +
      "  TELEGRAM_BOT_TOKEN=... roundhouse setup --user USERNAME\n" +
      "  roundhouse setup --bot-token TOKEN --user USERNAME",
    );
  }
  if (opts.users.length === 0 && !isInteractiveTelegram) {
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

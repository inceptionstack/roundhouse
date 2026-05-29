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
    force: false,
    dryRun: false,
    telegram: false,
    slack: false,
    slackBotToken: "",
    slackAppToken: "",
    slackSigningSecret: "",
    nonInteractive: false,
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
      case "--headless": opts.nonInteractive = true; break;  // alias
      case "--telegram": opts.telegram = true; break;
      case "--slack": opts.slack = true; break;
      case "--slack-bot-token": opts.slackBotToken = next(); break;
      case "--slack-app-token": opts.slackAppToken = next(); break;
      case "--slack-signing-secret": opts.slackSigningSecret = next(); break;
      case "--agent": opts.agent = next().toLowerCase(); opts._agentExplicit = true; break;
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
  if (!opts.slackBotToken) opts.slackBotToken = process.env.SLACK_BOT_TOKEN ?? "";
  if (!opts.slackAppToken) opts.slackAppToken = process.env.SLACK_APP_TOKEN ?? "";
  if (!opts.slackSigningSecret) opts.slackSigningSecret = process.env.SLACK_SIGNING_SECRET ?? "";

  // Non-interactive: warn about secrets in argv (visible in process listings)
  if (opts.nonInteractive && argv.some((a) => a === "--bot-token")) {
    throw new Error(
      "--bot-token is not accepted in --non-interactive mode (argv visible in process listings).\n" +
      "Use: TELEGRAM_BOT_TOKEN=... roundhouse setup --telegram --non-interactive --user USERNAME",
    );
  }
  if (
    opts.nonInteractive &&
    (argv.includes("--slack-bot-token") ||
      argv.includes("--slack-app-token") ||
      argv.includes("--slack-signing-secret"))
  ) {
    throw new Error(
      "--slack-bot-token / --slack-app-token / --slack-signing-secret are not accepted in --non-interactive mode (argv visible in process listings).\n" +
      "Use: SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... roundhouse setup --slack --non-interactive --user USERNAME",
    );
  }

  // Mutually-exclusive transport flags (a single setup invocation targets one)
  if (opts.telegram && opts.slack) {
    throw new Error("--telegram and --slack are mutually exclusive in a single setup invocation. Run setup twice if you want both.");
  }

  // Validate agent type
  try {
    getAgentDefinition(opts.agent);
  } catch (err: any) {
    throw new Error(err.message);
  }

  // Interactive flows defer token/user prompting to the wizard
  const isInteractiveTelegram = opts.telegram && !opts.nonInteractive && process.stdin.isTTY;
  const isInteractiveSlack = opts.slack && !opts.nonInteractive && process.stdin.isTTY;

  // Validate (Slack-vs-Telegram-aware)
  if (opts.slack) {
    if (!opts.slackBotToken && !opts.dryRun && !isInteractiveSlack) {
      throw new Error(
        "Slack bot token required. Provide via:\n" +
        "  SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… roundhouse setup --slack --user USERNAME",
      );
    }
    if (!opts.slackAppToken && !opts.dryRun && !isInteractiveSlack) {
      throw new Error(
        "Slack app token (xapp-…) required for socket mode. Provide via SLACK_APP_TOKEN env var.",
      );
    }
    if (opts.slackBotToken && !/^xoxb-/.test(opts.slackBotToken)) {
      throw new Error("--slack-bot-token must start with `xoxb-` (bot token).");
    }
    if (opts.slackAppToken && !/^xapp-/.test(opts.slackAppToken)) {
      throw new Error("--slack-app-token must start with `xapp-` (app-level token).");
    }
    if (opts.users.length === 0 && !isInteractiveSlack) {
      throw new Error(
        "At least one --user USERNAME is required.\n" +
        "This is your Slack username (display name, without @).",
      );
    }
  } else {
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
  }
  for (const ext of opts.extensions) {
    if (!EXTENSION_NAME_RE.test(ext)) {
      throw new Error(`Invalid extension name: ${ext}`);
    }
  }
  if (opts.notifyChatIds.some((id) => typeof id === "number" && isNaN(id))) {
    throw new Error("--notify-chat must be a number");
  }

  return opts;
}

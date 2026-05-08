import { dirname } from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { atomicWriteJson, execOrFail } from "./helpers";
import { type SetupOptions, type StepLog, PI_SETTINGS_PATH } from "./types";
import {
  getAgentDefinition,
  type AgentDefinition,
  type AgentSetupContext,
} from "../../agents/registry";
import { type SetupLogger } from "./logger";

export function resolveAgentForSetup(opts: SetupOptions, logger: StepLog): AgentDefinition {
  const agent = { ...getAgentDefinition(opts.agent) };

  if (agent.type === "pi") {
    agent.configure = async (ctx: AgentSetupContext) => {
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await readFile(PI_SETTINGS_PATH, "utf8"));
      } catch {}

      const settings: Record<string, unknown> = { ...existing };

      if (ctx.force) {
        settings.defaultProvider = ctx.provider;
        settings.defaultModel = ctx.model;
      } else {
        if (existing.defaultProvider && existing.defaultProvider !== ctx.provider) {
          logger.warn(`Pi provider already set to '${existing.defaultProvider}' (keeping, use --force to override)`);
        } else {
          settings.defaultProvider = ctx.provider;
        }
        if (existing.defaultModel && existing.defaultModel !== ctx.model) {
          logger.warn(`Pi model already set to '${existing.defaultModel}' (keeping, use --force to override)`);
        } else {
          settings.defaultModel = ctx.model;
        }
      }

      if (!Array.isArray(settings.packages)) settings.packages = [];

      const pkgs = settings.packages as string[];
      const selfPkg = "npm:@inceptionstack/roundhouse";
      const selfIdx = pkgs.indexOf(selfPkg);
      if (selfIdx !== -1) pkgs.splice(selfIdx, 1);

      const coreExtensions = [
        "npm:@inceptionstack/pi-hard-no",
        "npm:@inceptionstack/pi-branch-enforcer",
      ];
      for (const ext of coreExtensions) {
        if (!pkgs.includes(ext)) pkgs.push(ext);
      }

      if (ctx.psst) {
        const psstPkg = "npm:@miclivs/pi-psst";
        if (!pkgs.includes(psstPkg)) pkgs.push(psstPkg);
      }

      await mkdir(dirname(PI_SETTINGS_PATH), { recursive: true });
      await atomicWriteJson(PI_SETTINGS_PATH, settings);
      logger.ok(`~/.pi/agent/settings.json (${settings.defaultProvider}, ${settings.defaultModel})`);
    };

    agent.installExtension = async (ext: string) => {
      execOrFail("pi", ["install", `npm:${ext}`], `extension ${ext}`);
    };
  }

  return agent;
}

export const textLog = (msg: string): void => { console.log(msg); };

export const textStepLog: StepLog = {
  log: textLog,
  step(n, label) {
    textLog(`\n${n} ${label}`);
  },
  ok(msg) {
    textLog(`   ✓ ${msg}`);
  },
  warn(msg) {
    textLog(`   ⚠ ${msg}`);
  },
  fail(msg) {
    textLog(`   ✗ ${msg}`);
  },
};

export function createStepLog(logger: SetupLogger): StepLog {
  return {
    log(msg) {
      logger.info("log", msg);
    },
    step(n, label) {
      logger.info("step", label, { stepLabel: n });
    },
    ok(msg) {
      logger.ok(msg);
    },
    warn(msg) {
      logger.warn("warn", msg);
    },
    fail(msg) {
      logger.fail(msg);
    },
  };
}

import { readFile } from "node:fs/promises";
import { execOrFail } from "./helpers";
import { type SetupOptions, type StepLog, PI_SETTINGS_PATH } from "./types";
import { updatePiSettings } from "../../pi-settings";
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

      await updatePiSettings((settings) => {
        // Merge with what we read above (preserves any concurrent writes
        // since our read — the lock serialises the final RMW).
        const merged = { ...settings };

        if (ctx.force) {
          merged.defaultProvider = ctx.provider;
          merged.defaultModel = ctx.model;
        } else {
          if (existing.defaultProvider && existing.defaultProvider !== ctx.provider) {
            logger.warn(`Pi provider already set to '${existing.defaultProvider}' (keeping, use --force to override)`);
          } else {
            merged.defaultProvider = ctx.provider;
          }
          if (existing.defaultModel && existing.defaultModel !== ctx.model) {
            logger.warn(`Pi model already set to '${existing.defaultModel}' (keeping, use --force to override)`);
          } else {
            merged.defaultModel = ctx.model;
          }
        }

        if (!Array.isArray(merged.packages)) merged.packages = [];

        const pkgs = merged.packages as string[];
        const selfPkg = "npm:@inceptionstack/roundhouse";
        const selfIdx = pkgs.indexOf(selfPkg);
        if (selfIdx !== -1) pkgs.splice(selfIdx, 1);

        // coreExtensions is empty — pi-hard-no and pi-branch-enforcer are now opt-in
        const coreExtensions: string[] = [];
        for (const ext of coreExtensions) {
          if (!pkgs.includes(ext)) pkgs.push(ext);
        }

        if (ctx.psst) {
          const psstPkg = "npm:@miclivs/pi-psst";
          if (!pkgs.includes(psstPkg)) pkgs.push(psstPkg);
        }

        return merged;
      });

      logger.ok(`~/.pi/agent/settings.json (${existing.defaultProvider ?? ctx.provider}, ${existing.defaultModel ?? ctx.model})`);
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

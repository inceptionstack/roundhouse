/**
 * cli/cron.ts — roundhouse cron CLI dispatcher
 *
 * Parses args and dispatches to individual command handlers.
 */

import { CronStore } from "../cron/store";
import {
  cronAdd, cronList, cronShow, cronTrigger, cronRuns,
  cronPause, cronResume, cronEdit, cronDelete, cronHelp,
} from "./cron-commands";

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = "true";
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

const COMMANDS: Record<string, (store: CronStore, pos: string[], flags: Record<string, string>) => Promise<void>> = {
  add: cronAdd,
  list: cronList,
  show: cronShow,
  trigger: cronTrigger,
  run: cronTrigger,
  runs: cronRuns,
  pause: cronPause,
  resume: cronResume,
  edit: cronEdit,
  delete: cronDelete,
};

export async function cmdCron(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  const store = new CronStore();
  await store.ensureDirs();

  const handler = sub && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (handler) {
    await handler(store, positional, flags);
  } else {
    cronHelp();
  }
}

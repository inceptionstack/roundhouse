/**
 * gateway/later-command.ts — Handle the /later command
 *
 * Quickly capture ideas/notes to ~/.roundhouse/workspace/later.md
 * without interrupting the current conversation flow.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const WORKSPACE_DIR = join(homedir(), ".roundhouse", "workspace");
const LATER_PATH = join(WORKSPACE_DIR, "later.md");

export interface LaterCommandContext {
  thread: any;
  text: string;
  postWithFallback: (thread: any, text: string) => Promise<void>;
}

function ensureWorkspace(): void {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
}

function ensureLaterFile(): void {
  ensureWorkspace();
  if (!existsSync(LATER_PATH)) {
    appendFileSync(LATER_PATH, "# Later\n\nIdeas, reminders, and things to get back to.\n\n");
  }
}

export async function handleLater(ctx: LaterCommandContext): Promise<void> {
  const { thread, text, postWithFallback } = ctx;
  const idea = text.replace(/^\/later(@\S+)?\s*/i, "").trim();

  // No argument: show contents
  if (!idea) {
    ensureLaterFile();
    const contents = readFileSync(LATER_PATH, "utf8").trim();
    const lines = contents.split("\n").filter(l => l.startsWith("- "));
    if (lines.length === 0) {
      await postWithFallback(thread, "📋 *Later list is empty.*\n\n_Usage:_ `/later buy more coffee`");
    } else {
      await postWithFallback(thread, `📋 *Later* (${lines.length} items):\n\n${lines.join("\n")}\n\n_File:_ \`~/.roundhouse/workspace/later.md\``);
    }
    return;
  }

  // Append the idea
  ensureLaterFile();
  const timestamp = new Date().toISOString().slice(0, 10);
  appendFileSync(LATER_PATH, `- ${idea} _(${timestamp})_\n`);

  await postWithFallback(thread, `✅ Saved: "${idea}"`);
}

/**
 * memory/bootstrap.ts — Create default memory file templates
 *
 * Creates MEMORY.md, memory-rules.md, and daily/ directory if they don't exist.
 * Mode-aware: writes different memory-rules.md for Full vs Complement mode.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileExists } from "../config";
import type { MemoryConfig, MemoryMode } from "./types";

const DEFAULT_MEMORY_MD = `# Memory

Durable facts, preferences, decisions, and stable project context.
Keep under 100 lines. Prefer editing existing entries over appending duplicates.
`;

const RULES_FULL = `# Memory Rules

You have no built-in memory extension. Roundhouse manages your memory via workspace files.

## Always-injected files
- ~/MEMORY.md — durable facts, preferences, decisions, project context
- Today's daily front page — headlines + leads + article links
- This file (memory-rules.md)

## MEMORY.md
- Keep under 100 lines
- Store user preferences, project conventions, architecture decisions
- Edit existing entries rather than appending duplicates
- When the user corrects you or states a preference, ALWAYS write it here

## Daily front pages
- Keep under 2K tokens
- Headlines + leads + relative links to articles
- No long logs, transcripts, or command output

## Articles
- Full details in daily/YYYY-MM-DD/articles/
- New article per new durable topic; append for continuing work
- Agent reads articles on demand with file tools
`;

const RULES_COMPLEMENT = `# Memory Rules

You have a memory extension installed that handles facts, preferences, and corrections.
Use memory_remember for discrete facts. Use memory_search to recall them.

Roundhouse manages narrative context separately:

## Always-injected files
- ~/MEMORY.md — high-level project context, architecture decisions, active investigations
- Today's daily front page — headlines + leads + article links
- This file (memory-rules.md)

## MEMORY.md
- NOT for individual preferences (those go in memory_remember)
- For ongoing project/architecture context that doesn't fit key-value storage
- Keep under 100 lines

## Daily front pages
- Keep under 2K tokens
- Headlines + leads + relative links to articles

## Articles
- Full details in daily/YYYY-MM-DD/articles/
- Agent reads on demand with file tools
`;

/**
 * Ensure memory directory structure and default files exist.
 * Does not overwrite existing files.
 */
export async function bootstrapMemoryFiles(rootDir: string, mode: MemoryMode, config?: MemoryConfig): Promise<void> {
  const mainFile = config?.mainFile ?? "MEMORY.md";
  const dailyDir = config?.dailyDir ?? "daily";

  // Ensure directories
  await mkdir(resolve(rootDir, dailyDir), { recursive: true });

  // Create MEMORY.md if missing
  const memoryPath = resolve(rootDir, mainFile);
  if (!await fileExists(memoryPath)) {
    await writeFile(memoryPath, DEFAULT_MEMORY_MD);
    console.log(`[memory] created ${memoryPath}`);
  }

  // Create/update memory-rules.md based on mode
  const rulesPath = resolve(rootDir, "memory-rules.md");
  const rulesContent = mode === "complement" ? RULES_COMPLEMENT : RULES_FULL;

  // Only write if doesn't exist or mode changed (check first line)
  if (!await fileExists(rulesPath)) {
    await writeFile(rulesPath, rulesContent);
    console.log(`[memory] created ${rulesPath} (mode: ${mode})`);
  }
}

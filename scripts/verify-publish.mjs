#!/usr/bin/env node
/**
 * Verify npm publish succeeded by spawning a background agent
 * to check registry, version, and dist tags.
 *
 * Only runs in interactive shells (skip CI, dry-run, non-TTY).
 * Detaches to background to avoid blocking npm publish.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

// Skip in CI, dry-run, or non-interactive shells
if (process.env.CI || process.env.npm_config_dry_run || !process.stdout.isTTY) {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// Try to find roundhouse: global PATH or local bin
let roundhouseCmd = 'roundhouse';
const localBin = resolve(repoRoot, 'node_modules/.bin/roundhouse');
if (existsSync(localBin)) {
  roundhouseCmd = localBin;
}

// Spawn agent in background (detached, non-blocking)
try {
  const child = spawn(roundhouseCmd, [
    'subagent', 'spawn',
    '--role', 'review',
    '--task', 'Verify npm publish succeeded for @inceptionstack/roundhouse. Check registry, version, and dist tags.',
    '--cwd', repoRoot,
    '--timeout', '120000'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  child.unref(); // Allow parent (npm publish) to exit without waiting
} catch (err) {
  if (err.code === 'ENOENT') {
    console.warn(`⚠️  Warning: roundhouse not found on PATH. Publish verification skipped. Install roundhouse globally or ensure it's in your PATH.`);
  }
  process.exit(0);
}

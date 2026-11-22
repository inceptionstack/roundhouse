/**
 * Vitest setup file: every test file gets its own empty HOME, set before the
 * test file (and so any src module) is imported. Paths such as ROUNDHOUSE_DIR
 * are computed from homedir() at import time, so state written by one file can
 * never be seen by another file or by the next run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const parent = process.env.ROUNDHOUSE_TEST_HOME_ROOT ?? tmpdir();
const home = mkdtempSync(join(parent, "file-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Vitest global setup: run the whole suite with HOME pointing at a throwaway
 * directory, so nothing (tests, the processes they spawn, tools they shell out
 * to) can read or write the real ~/.roundhouse, ~/.pi or ~/.mcporter.
 * Runs in the main process before any worker starts; workers inherit the env.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  const root = mkdtempSync(join(tmpdir(), "roundhouse-test-home-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.ROUNDHOUSE_TEST_HOME_ROOT = root;

  return () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    delete process.env.ROUNDHOUSE_TEST_HOME_ROOT;
    rmSync(root, { recursive: true, force: true });
  };
}

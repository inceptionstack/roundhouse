/**
 * Tests for /toggle-enforce-branches command
 *
 * Strategy: characterization tests against the real filesystem using a
 * dedicated tmp HOME so we don't touch ~/.pi-branch-enforcer/disabled on
 * the dev machine. The handler reads HOME via os.homedir() — which on
 * Linux respects $HOME — so overriding $HOME redirects all marker writes.
 *
 * We import the command module fresh per test (vitest module reset) so
 * the homedir() value captured at module-load time picks up the new $HOME.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let originalHome: string | undefined;
let posts: string[];
let postWithFallback: (thread: any, text: string) => Promise<void>;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "roundhouse-toggle-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  posts = [];
  postWithFallback = async (_t, text) => { posts.push(text); };
  // Force re-resolution of homedir() inside the command module
  vi.resetModules();
  // Sanity: confirm os.homedir() now returns our tmpHome
  expect(homedir()).toBe(tmpHome);
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const markerPath = () => join(tmpHome, ".pi-branch-enforcer", "disabled");

async function callHandler(text: string): Promise<void> {
  const mod = await import("../src/gateway/toggle-enforce-branches-command");
  await mod.handleToggleEnforceBranches({
    thread: { id: "test" },
    text,
    postWithFallback,
  });
}

describe("/toggle-enforce-branches", () => {
  test("status_initialState_reportsEnabled", async () => {
    await callHandler("/toggle-enforce-branches status");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("ENABLED");
    expect(existsSync(markerPath())).toBe(false);
  });

  test("status_markerExists_reportsDisabled", async () => {
    mkdirSync(join(tmpHome, ".pi-branch-enforcer"), { recursive: true });
    writeFileSync(markerPath(), "test");
    await callHandler("/toggle-enforce-branches status");
    expect(posts[0]).toContain("DISABLED");
  });

  test("toggle_fromEnabled_disablesAndCreatesMarker", async () => {
    await callHandler("/toggle-enforce-branches");
    expect(existsSync(markerPath())).toBe(true);
    expect(posts[0]).toContain("DISABLED");
    expect(posts[0]).toContain("Updated");
  });

  test("toggle_fromDisabled_enablesAndRemovesMarker", async () => {
    mkdirSync(join(tmpHome, ".pi-branch-enforcer"), { recursive: true });
    writeFileSync(markerPath(), "x");
    await callHandler("/toggle-enforce-branches");
    expect(existsSync(markerPath())).toBe(false);
    expect(posts[0]).toContain("ENABLED");
  });

  test("explicitOff_whenAlreadyEnabled_disables", async () => {
    await callHandler("/toggle-enforce-branches off");
    expect(existsSync(markerPath())).toBe(true);
    expect(posts[0]).toContain("DISABLED");
  });

  test("explicitOff_whenAlreadyDisabled_isIdempotentNoChange", async () => {
    mkdirSync(join(tmpHome, ".pi-branch-enforcer"), { recursive: true });
    writeFileSync(markerPath(), "x");
    await callHandler("/toggle-enforce-branches off");
    expect(existsSync(markerPath())).toBe(true);
    expect(posts[0]).toContain("Already in target state");
    expect(posts[0]).toContain("DISABLED");
  });

  test("explicitOn_whenDisabled_enables", async () => {
    mkdirSync(join(tmpHome, ".pi-branch-enforcer"), { recursive: true });
    writeFileSync(markerPath(), "x");
    await callHandler("/toggle-enforce-branches on");
    expect(existsSync(markerPath())).toBe(false);
    expect(posts[0]).toContain("ENABLED");
  });

  test("explicitOn_whenAlreadyEnabled_isIdempotentNoChange", async () => {
    await callHandler("/toggle-enforce-branches on");
    expect(existsSync(markerPath())).toBe(false);
    expect(posts[0]).toContain("Already in target state");
  });

  test("aliases_enableAndDisable_work", async () => {
    await callHandler("/toggle-enforce-branches disable");
    expect(existsSync(markerPath())).toBe(true);
    posts.length = 0;
    await callHandler("/toggle-enforce-branches enable");
    expect(existsSync(markerPath())).toBe(false);
  });

  test("unknownArg_postsUsageWithoutChanging", async () => {
    await callHandler("/toggle-enforce-branches blah");
    expect(existsSync(markerPath())).toBe(false);
    expect(posts[0]).toContain("Usage:");
  });
});

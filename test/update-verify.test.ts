/**
 * test/update-verify.test.ts
 *
 * Regression tests for verify-after-fail behaviour in cli/update.ts.
 *
 * Bug background: on hosts where Node is managed by mise (and similar tools
 * like nvm), `npm install -g` triggers a post-install reshim hook. If that
 * hook can't find `mise` on PATH it exits 127, causing `execSync` to throw
 * even though the package was actually written to disk correctly.
 *
 * Behaviour under test: when the install command throws, `updateSelf` and
 * `updateExtensions` consult `npm list -g` and trust the on-disk version
 * over the exit code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TARGET_VERSION = "9.9.9";
const SELF_PKG = "@inceptionstack/roundhouse";

// Per-test programmable behaviour for the mocked execSync.
type ExecMock = (cmd: string) => string;
let execMock: ExecMock = () => "";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string, _opts?: any) => execMock(cmd)),
}));

async function importUpdateFresh() {
  vi.resetModules();
  return await import("../src/cli/update");
}

function makeProgress() {
  const messages: string[] = [];
  return {
    messages,
    update: async (msg: string) => { messages.push(msg); },
  };
}

describe("updateSelf — verify-after-fail (mise/nvm reshim resilience)", () => {
  beforeEach(() => {
    execMock = () => "";
  });

  it("reports success when install throws but on-disk version matches latest", async () => {
    execMock = (cmd: string) => {
      if (cmd.startsWith("npm install -g")) {
        // Simulate mise post-install hook exit 127.
        const err: any = new Error("Command failed: npm install -g … exit 127");
        throw err;
      }
      if (cmd.startsWith("npm list -g")) {
        return JSON.stringify({ dependencies: { [SELF_PKG]: { version: TARGET_VERSION } } });
      }
      return "";
    };

    const { updateSelf } = await importUpdateFresh();
    const progress = makeProgress();
    const result = await updateSelf(progress, "9.9.8", TARGET_VERSION);

    expect(result).toBeUndefined(); // undefined === success
  });

  it("reports failure when install throws and on-disk version is stale", async () => {
    execMock = (cmd: string) => {
      if (cmd.startsWith("npm install -g")) {
        throw new Error("Command failed: npm install -g … network error");
      }
      if (cmd.startsWith("npm list -g")) {
        return JSON.stringify({ dependencies: { [SELF_PKG]: { version: "9.9.7" } } });
      }
      return "";
    };

    const { updateSelf } = await importUpdateFresh();
    const result = await updateSelf(makeProgress(), "9.9.7", TARGET_VERSION);

    expect(result).toMatch(/Self-update failed/);
  });

  it("reports failure when install throws and package is not installed at all", async () => {
    execMock = (cmd: string) => {
      if (cmd.startsWith("npm install -g")) throw new Error("ENOENT");
      if (cmd.startsWith("npm list -g")) return JSON.stringify({ dependencies: {} });
      return "";
    };

    const { updateSelf } = await importUpdateFresh();
    const result = await updateSelf(makeProgress(), "9.9.7", TARGET_VERSION);

    expect(result).toMatch(/Self-update failed/);
  });

  it("reports failure when verification itself errors out", async () => {
    execMock = (cmd: string) => {
      if (cmd.startsWith("npm install -g")) throw new Error("Command failed");
      if (cmd.startsWith("npm list -g")) throw new Error("npm not found");
      return "";
    };

    const { updateSelf } = await importUpdateFresh();
    const result = await updateSelf(makeProgress(), "9.9.7", TARGET_VERSION);

    expect(result).toMatch(/Self-update failed/);
  });
});

describe("updateExtensions — verify-after-fail", () => {
  beforeEach(() => {
    execMock = () => "";
  });

  it("treats install-with-reshim-error as success when on-disk version matches", async () => {
    let installCalled = false;
    execMock = (cmd: string) => {
      if (cmd.startsWith("npm install -g")) {
        installCalled = true;
        throw new Error("Command failed: npm install -g … exit 127");
      }
      if (cmd.startsWith("npm view")) return TARGET_VERSION;
      if (cmd.startsWith("npm list -g")) {
        // First call (pre-install): old version. Subsequent (post-fail verify): new version.
        return installCalled
          ? JSON.stringify({ dependencies: { "@inceptionstack/pi-hard-no": { version: TARGET_VERSION } } })
          : JSON.stringify({ dependencies: { "@inceptionstack/pi-hard-no": { version: "0.0.1" } } });
      }
      return "";
    };

    const { updateExtensions } = await importUpdateFresh();
    const progress = makeProgress();
    await updateExtensions(progress);

    const successMsgs = progress.messages.filter((m) => m.includes("✅") && m.includes("pi-hard-no"));
    expect(successMsgs.length).toBeGreaterThan(0);
    const failureMsgs = progress.messages.filter((m) => m.includes("⚠️") && m.includes("pi-hard-no"));
    expect(failureMsgs).toHaveLength(0);
  });
});

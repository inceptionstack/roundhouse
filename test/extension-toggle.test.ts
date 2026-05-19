/**
 * test/extension-toggle.test.ts — Tests for /toggle-quality-inspector and /toggle-branch-enforcer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const TEST_DIR = resolve(tmpdir(), `ext-toggle-test-${randomBytes(4).toString("hex")}`);

// Mock homedir before any imports that use it
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => resolve(TEST_DIR, "fakehome"),
  };
});

function getSettingsPath(): string {
  return resolve(TEST_DIR, "fakehome", ".pi", "agent", "settings.json");
}

function ensureSettingsDir(): void {
  mkdirSync(resolve(TEST_DIR, "fakehome", ".pi", "agent"), { recursive: true });
}

describe("extension-toggle-command", () => {
  beforeEach(() => {
    ensureSettingsDir();
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe("handleToggleQualityInspector", () => {
    it("'on' enables pi-hard-no and returns confirmation", async () => {
      const { handleToggleQualityInspector } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: [] }));
      const result = await handleToggleQualityInspector({ text: "/toggle-quality-inspector on" });
      expect(result.text).toContain("ON");
      expect(result.text).toContain("✅");
      expect(result.text).toContain("/restart");
      const content = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      expect(content.packages).toContain("npm:@inceptionstack/pi-hard-no");
    });

    it("'off' disables pi-hard-no and returns confirmation", async () => {
      const { handleToggleQualityInspector } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: ["npm:@inceptionstack/pi-hard-no"] }));
      const result = await handleToggleQualityInspector({ text: "/toggle-quality-inspector off" });
      expect(result.text).toContain("OFF");
      expect(result.text).toContain("🚫");
      expect(result.text).toContain("/restart");
      const content = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      expect(content.packages).not.toContain("npm:@inceptionstack/pi-hard-no");
    });

    it("no arg returns menu with current state (RichResponse with menu)", async () => {
      const { handleToggleQualityInspector } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: ["npm:@inceptionstack/pi-hard-no"] }));
      const result = await handleToggleQualityInspector({ text: "/toggle-quality-inspector" });
      expect(result.menu).toBeDefined();
      expect(result.text).toContain("ON");
      // The ON button should be selected
      const onBtn = result.menu!.sections[0].buttons.find((b: any) => b.value === "on");
      expect(onBtn?.selected).toBe(true);
    });

    it("idempotent: second 'on' returns (no change)", async () => {
      const { handleToggleQualityInspector } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: ["npm:@inceptionstack/pi-hard-no"] }));
      const result = await handleToggleQualityInspector({ text: "/toggle-quality-inspector on" });
      expect(result.text).toContain("(no change)");
      expect(result.text).not.toContain("/restart");
    });
  });

  describe("handleExtToggleQiAction", () => {
    it("action handler with value='on' enables package", async () => {
      const { handleExtToggleQiAction } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: [] }));
      const result = await handleExtToggleQiAction({ value: "on" });
      expect(result).toBeDefined();
      expect(result!.text).toContain("ON");
      const content = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      expect(content.packages).toContain("npm:@inceptionstack/pi-hard-no");
    });

    it("action handler with value='off' disables package", async () => {
      const { handleExtToggleQiAction } = await import("../src/gateway/extension-toggle-command");
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: ["npm:@inceptionstack/pi-hard-no"] }));
      const result = await handleExtToggleQiAction({ value: "off" });
      expect(result).toBeDefined();
      expect(result!.text).toContain("OFF");
    });
  });

  describe("live dispatch (regression)", () => {
    it("/toggle-quality-inspector reaches transport.postRich with the original transport thread", async () => {
      const { Gateway } = await import("../src/gateway/gateway");
      const { isCommand, isCommandWithArgs } = await import("../src/gateway/helpers");

      const router = {
        resolve: () => ({ name: "noop" } as any),
        dispose: async () => {},
      };
      const config = {
        agent: { type: "noop" },
        chat: { botUsername: "test", adapters: {} },
      } as any;
      const postRich = vi.fn(async () => {});
      const transport = { postRich, progress: vi.fn() };
      const gw = new Gateway(router, config);
      (gw as any).transport = transport;

      // Write settings so the command handler can read them
      writeFileSync(getSettingsPath(), JSON.stringify({ packages: [] }));

      const internals = gw as any;
      const all = internals.buildCommandDescriptors({
        allowedUsers: [], allowedUserIds: [], verboseThreads: new Set(),
        threadLocks: new Map(), abortControllers: new Map(),
      });

      // Pre-turn commands — dispatchInTurnCommand works for any descriptor list
      const preTurn = all.filter((d: any) => d.stage === "pre-turn");
      const matchers = {
        isCommand: (t: string, c: string) => isCommand(t, c, "test"),
        isCommandWithArgs: (t: string, c: string) => isCommandWithArgs(t, c, "test"),
      };

      const transportThread = { id: "telegram:42", post: vi.fn() };

      // dispatchInTurnCommand works for any descriptor list (it's just match+invoke+post)
      const handled = await internals.dispatchInTurnCommand(
        preTurn, matchers,
        transportThread, { text: "/toggle-quality-inspector on" },
        "/toggle-quality-inspector on", "main",
      );
      expect(handled).toBe(true);
      expect(postRich).toHaveBeenCalledTimes(1);

      const [passedThread, passedResponse] = postRich.mock.calls[0];
      expect(passedThread).toBe(transportThread);
      expect(passedResponse.text).toContain("ON");
    });
  });
});

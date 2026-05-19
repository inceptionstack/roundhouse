/**
 * test/pi-settings.test.ts — Unit tests for src/pi-settings.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// We test via the real module but with a patched PI_SETTINGS_PATH
// to avoid touching the real ~/.pi/agent/settings.json.
// Vitest runs in the same process, so we mock the constant via vi.mock.

const TEST_DIR = resolve(tmpdir(), `pi-settings-test-${randomBytes(4).toString("hex")}`);
const TEST_SETTINGS_PATH = resolve(TEST_DIR, "settings.json");
const TEST_LOCK_PATH = resolve(TEST_DIR, ".settings.lock");

import { vi } from "vitest";

// Mock the paths used by pi-settings
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => resolve(TEST_DIR, "fakehome"),
  };
});

// The module uses resolve(homedir(), ".pi", "agent", "settings.json")
// With our mocked homedir, it becomes TEST_DIR/fakehome/.pi/agent/settings.json
function getSettingsPath(): string {
  return resolve(TEST_DIR, "fakehome", ".pi", "agent", "settings.json");
}

describe("pi-settings", () => {
  beforeEach(() => {
    mkdirSync(resolve(TEST_DIR, "fakehome", ".pi", "agent"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  // Dynamic import to pick up the mocked homedir
  async function getModule() {
    // Clear module cache to get fresh imports with mocked homedir
    const mod = await import("../src/pi-settings");
    return mod;
  }

  describe("readPiSettings", () => {
    it("returns {} when file does not exist", async () => {
      const { readPiSettings } = await getModule();
      const result = await readPiSettings();
      expect(result).toEqual({});
    });

    it("returns parsed settings from valid JSON", async () => {
      const { readPiSettings } = await getModule();
      const settingsPath = getSettingsPath();
      writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "test", packages: ["a"] }));
      const result = await readPiSettings();
      expect(result.defaultProvider).toBe("test");
      expect(result.packages).toEqual(["a"]);
    });

    it("throws MalformedPiSettingsError on invalid JSON", async () => {
      const { readPiSettings, MalformedPiSettingsError } = await getModule();
      const settingsPath = getSettingsPath();
      writeFileSync(settingsPath, "not json {{{");
      await expect(readPiSettings()).rejects.toThrow(MalformedPiSettingsError);
    });
  });

  describe("writePiSettings", () => {
    it("writes atomic JSON and deduplicates packages", async () => {
      const { writePiSettings } = await getModule();
      const settingsPath = getSettingsPath();
      await writePiSettings({ defaultProvider: "p", packages: ["a", "b", "a"] });
      const content = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(content.packages).toEqual(["a", "b"]);
      expect(content.defaultProvider).toBe("p");
    });

    it("cleans up tmp file on success (no stale .tmp files)", async () => {
      const { writePiSettings } = await getModule();
      await writePiSettings({ packages: [] });
      const dir = dirname(getSettingsPath());
      const files = require("node:fs").readdirSync(dir);
      const tmpFiles = files.filter((f: string) => f.includes(".tmp."));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("updatePiSettings", () => {
    it("serialises concurrent calls (all mutations observed)", async () => {
      const { updatePiSettings } = await getModule();
      const settingsPath = getSettingsPath();
      writeFileSync(settingsPath, JSON.stringify({ count: 0 }));

      // Run 10 concurrent increments
      const promises = Array.from({ length: 10 }, () =>
        updatePiSettings((s) => ({ ...s, count: ((s as any).count ?? 0) + 1 })),
      );
      await Promise.all(promises);

      const result = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(result.count).toBe(10);
    });
  });

  describe("enablePiPackage", () => {
    it("adds package to empty settings", async () => {
      const { enablePiPackage } = await getModule();
      const { changed } = await enablePiPackage("npm:test-pkg");
      expect(changed).toBe(true);
      const content = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      expect(content.packages).toContain("npm:test-pkg");
    });

    it("is idempotent — second call returns changed=false", async () => {
      const { enablePiPackage } = await getModule();
      await enablePiPackage("npm:test-pkg");
      const { changed } = await enablePiPackage("npm:test-pkg");
      expect(changed).toBe(false);
    });
  });

  describe("disablePiPackage", () => {
    it("removes package from existing packages", async () => {
      const { enablePiPackage, disablePiPackage } = await getModule();
      await enablePiPackage("npm:test-pkg");
      const { changed } = await disablePiPackage("npm:test-pkg");
      expect(changed).toBe(true);
      const content = JSON.parse(readFileSync(getSettingsPath(), "utf8"));
      expect(content.packages).not.toContain("npm:test-pkg");
    });

    it("is idempotent — removing non-existent pkg returns changed=false", async () => {
      const { disablePiPackage } = await getModule();
      const settingsPath = getSettingsPath();
      writeFileSync(settingsPath, JSON.stringify({ packages: ["other"] }));
      const { changed } = await disablePiPackage("npm:not-there");
      expect(changed).toBe(false);
    });
  });

  describe("deduplication", () => {
    it("deduplicates packages on write", async () => {
      const { updatePiSettings } = await getModule();
      const settingsPath = getSettingsPath();
      writeFileSync(settingsPath, JSON.stringify({ packages: ["a", "b", "a", "c", "b"] }));
      await updatePiSettings((s) => s); // identity mutation triggers write
      const content = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(content.packages).toEqual(["a", "b", "c"]);
    });
  });

  describe("malformed JSON preservation", () => {
    it("does not modify file on malformed JSON error", async () => {
      const { enablePiPackage, MalformedPiSettingsError } = await getModule();
      const settingsPath = getSettingsPath();
      const badContent = "{invalid json here";
      writeFileSync(settingsPath, badContent);
      await expect(enablePiPackage("npm:test")).rejects.toThrow(MalformedPiSettingsError);
      // File unchanged
      expect(readFileSync(settingsPath, "utf8")).toBe(badContent);
    });
  });
});

/**
 * code-review-toggle.test.ts — Tests for the pi-hard-no enabled flag I/O.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toggleEnabled, readEnabled, resolveSettingsPath } from "./code-review-toggle";

let tmpRoots: string[] = [];
function makeFakeHome(): { home: string; settingsPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rh-toggle-"));
  tmpRoots.push(home);
  return { home, settingsPath: join(home, ".pi", ".hardno", "settings.json") };
}
afterEach(() => {
  for (const r of tmpRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

describe("resolveSettingsPath", () => {
  it("joins home + ~/.pi/.hardno/settings.json", () => {
    expect(resolveSettingsPath("/fake/home")).toBe("/fake/home/.pi/.hardno/settings.json");
  });
});

describe("readEnabled", () => {
  it("returns null when file does not exist", () => {
    const h = makeFakeHome();
    expect(readEnabled(h.home)).toBeNull();
  });

  it("returns true when enabled=true", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: true }));
    expect(readEnabled(h.home)).toBe(true);
  });

  it("returns false when enabled=false", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: false, model: "x/y" }));
    expect(readEnabled(h.home)).toBe(false);
  });

  it("returns null when enabled key absent", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ model: "x/y" }));
    expect(readEnabled(h.home)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, "{ not json");
    expect(readEnabled(h.home)).toBeNull();
  });

  it("returns null on non-boolean enabled (string)", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: "yes" }));
    expect(readEnabled(h.home)).toBeNull();
  });
});

describe("toggleEnabled", () => {
  it("creates settings file when missing, flips default true → false", () => {
    const h = makeFakeHome();
    const result = toggleEnabled(h.home);
    expect(result.enabled).toBe(false);
    expect(result.fileExisted).toBe(false);
    expect(result.settingsPath).toBe(h.settingsPath);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(false);
  });

  it("flips false → true", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: false }));
    const result = toggleEnabled(h.home);
    expect(result.enabled).toBe(true);
    expect(result.fileExisted).toBe(true);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(true);
  });

  it("flips true → false", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: true }));
    const result = toggleEnabled(h.home);
    expect(result.enabled).toBe(false);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(false);
  });

  it("preserves other fields when flipping", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(
      h.settingsPath,
      JSON.stringify({ enabled: true, model: "a/b", reviewTimeoutMs: 99_999, nested: { k: 1 } })
    );
    toggleEnabled(h.home);
    const parsed = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    expect(parsed.enabled).toBe(false);
    expect(parsed.model).toBe("a/b");
    expect(parsed.reviewTimeoutMs).toBe(99_999);
    expect(parsed.nested).toEqual({ k: 1 });
  });

  it("treats missing enabled key as default true → flips to false", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ model: "x/y" }));
    const result = toggleEnabled(h.home);
    expect(result.enabled).toBe(false);
    const parsed = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    expect(parsed.enabled).toBe(false);
    expect(parsed.model).toBe("x/y");
  });

  it("recovers from malformed existing file by overwriting", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, "{ corrupt");
    const result = toggleEnabled(h.home);
    expect(result.enabled).toBe(false);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(false);
  });

  it("leaves no tmp file behind after write", () => {
    const h = makeFakeHome();
    toggleEnabled(h.home);
    const dir = join(h.home, ".pi", ".hardno");
    const files = readdirSync(dir);
    expect(files.some(f => f.startsWith("settings.json.tmp"))).toBe(false);
    expect(files).toContain("settings.json");
    expect(existsSync(h.settingsPath)).toBe(true);
  });

  it("two consecutive toggles return to original state", () => {
    const h = makeFakeHome();
    const r1 = toggleEnabled(h.home);
    const r2 = toggleEnabled(h.home);
    expect(r1.enabled).toBe(false);
    expect(r2.enabled).toBe(true);
  });
});

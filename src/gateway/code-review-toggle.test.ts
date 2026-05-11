/**
 * code-review-toggle.test.ts — Tests for the pi-hard-no enabled flag I/O.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  toggleEnabled,
  readEnabled,
  resolveSettingsPath,
  resolveGlobalSettingsPath,
} from "./code-review-toggle";

let tmpRoots: string[] = [];
function makeFakeHome(): { home: string; settingsPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rh-toggle-"));
  tmpRoots.push(home);
  return { home, settingsPath: join(home, ".pi", ".hardno", "settings.json") };
}
function makeCwdHome(): {
  home: string;
  cwd: string;
  globalPath: string;
  localPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "rh-toggle-cwd-"));
  tmpRoots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    cwd,
    globalPath: join(home, ".pi", ".hardno", "settings.json"),
    localPath: join(cwd, ".hardno", "settings.json"),
  };
}
afterEach(() => {
  for (const r of tmpRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

describe("resolveGlobalSettingsPath", () => {
  it("joins home + ~/.pi/.hardno/settings.json", () => {
    expect(resolveGlobalSettingsPath("/fake/home")).toBe("/fake/home/.pi/.hardno/settings.json");
  });
});

describe("resolveSettingsPath (F6 fix: local-vs-global routing)", () => {
  it("returns global when no cwd given", () => {
    const h = makeFakeHome();
    const r = resolveSettingsPath({ home: h.home });
    expect(r.path).toBe(h.settingsPath);
    expect(r.isLocal).toBe(false);
  });

  it("returns global when cwd given but no local file exists", () => {
    const d = makeCwdHome();
    const r = resolveSettingsPath({ home: d.home, cwd: d.cwd });
    expect(r.path).toBe(d.globalPath);
    expect(r.isLocal).toBe(false);
  });

  it("returns local when cwd given AND local .hardno/settings.json exists", () => {
    const d = makeCwdHome();
    mkdirSync(join(d.cwd, ".hardno"), { recursive: true });
    writeFileSync(d.localPath, "{}");
    const r = resolveSettingsPath({ home: d.home, cwd: d.cwd });
    expect(r.path).toBe(d.localPath);
    expect(r.isLocal).toBe(true);
  });
});

describe("readEnabled", () => {
  it("returns null when no file exists (global)", () => {
    const h = makeFakeHome();
    expect(readEnabled({ home: h.home })).toBeNull();
  });

  it("reads true from global", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: true }));
    expect(readEnabled({ home: h.home })).toBe(true);
  });

  it("reads false from global", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: false, model: "x/y" }));
    expect(readEnabled({ home: h.home })).toBe(false);
  });

  it("returns null when enabled key absent", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ model: "x/y" }));
    expect(readEnabled({ home: h.home })).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, "{ not json");
    expect(readEnabled({ home: h.home })).toBeNull();
  });

  it("reads local when cwd given and local exists (local wins)", () => {
    const d = makeCwdHome();
    mkdirSync(join(d.home, ".pi", ".hardno"), { recursive: true });
    mkdirSync(join(d.cwd, ".hardno"), { recursive: true });
    writeFileSync(d.globalPath, JSON.stringify({ enabled: false }));
    writeFileSync(d.localPath, JSON.stringify({ enabled: true }));
    expect(readEnabled({ home: d.home, cwd: d.cwd })).toBe(true);
  });
});

describe("toggleEnabled", () => {
  it("creates global settings file when missing, flips default true → false", () => {
    const h = makeFakeHome();
    const result = toggleEnabled({ home: h.home });
    expect(result.enabled).toBe(false);
    expect(result.fileExisted).toBe(false);
    expect(result.wroteLocal).toBe(false);
    expect(result.settingsPath).toBe(h.settingsPath);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(false);
  });

  it("flips false → true (global)", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: false }));
    const result = toggleEnabled({ home: h.home });
    expect(result.enabled).toBe(true);
    expect(result.fileExisted).toBe(true);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(true);
  });

  it("flips true → false (global)", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, JSON.stringify({ enabled: true }));
    const result = toggleEnabled({ home: h.home });
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
    toggleEnabled({ home: h.home });
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
    const result = toggleEnabled({ home: h.home });
    expect(result.enabled).toBe(false);
    const parsed = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    expect(parsed.enabled).toBe(false);
    expect(parsed.model).toBe("x/y");
  });

  it("recovers from malformed existing file by overwriting", () => {
    const h = makeFakeHome();
    mkdirSync(join(h.home, ".pi", ".hardno"), { recursive: true });
    writeFileSync(h.settingsPath, "{ corrupt");
    const result = toggleEnabled({ home: h.home });
    expect(result.enabled).toBe(false);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).enabled).toBe(false);
  });

  it("leaves no tmp file behind after write", () => {
    const h = makeFakeHome();
    toggleEnabled({ home: h.home });
    const dir = join(h.home, ".pi", ".hardno");
    const files = readdirSync(dir);
    expect(files.some(f => f.startsWith("settings.json.tmp"))).toBe(false);
    expect(files).toContain("settings.json");
    expect(existsSync(h.settingsPath)).toBe(true);
  });

  it("two consecutive toggles return to original state", () => {
    const h = makeFakeHome();
    const r1 = toggleEnabled({ home: h.home });
    const r2 = toggleEnabled({ home: h.home });
    expect(r1.enabled).toBe(false);
    expect(r2.enabled).toBe(true);
  });
});

describe("toggleEnabled routing (F6 fix)", () => {
  it("writes local when local file exists, leaves global untouched", () => {
    const d = makeCwdHome();
    mkdirSync(join(d.cwd, ".hardno"), { recursive: true });
    writeFileSync(d.localPath, JSON.stringify({ model: "m/1" }));

    const result = toggleEnabled({ home: d.home, cwd: d.cwd });

    expect(result.wroteLocal).toBe(true);
    expect(result.settingsPath).toBe(d.localPath);
    const local = JSON.parse(readFileSync(d.localPath, "utf8"));
    expect(local.enabled).toBe(false);
    expect(local.model).toBe("m/1");
    expect(existsSync(d.globalPath)).toBe(false);
  });

  it("writes global when cwd given but no local file", () => {
    const d = makeCwdHome();
    const result = toggleEnabled({ home: d.home, cwd: d.cwd });
    expect(result.wroteLocal).toBe(false);
    expect(result.settingsPath).toBe(d.globalPath);
    expect(existsSync(d.localPath)).toBe(false);
    expect(JSON.parse(readFileSync(d.globalPath, "utf8")).enabled).toBe(false);
  });

  it("end-to-end: toggle with cwd writes local, read with cwd sees it (no masking)", () => {
    const d = makeCwdHome();
    mkdirSync(join(d.home, ".pi", ".hardno"), { recursive: true });
    mkdirSync(join(d.cwd, ".hardno"), { recursive: true });
    // Pre-existing local without `enabled`
    writeFileSync(d.localPath, JSON.stringify({ model: "x/y" }));
    // Pre-existing global with enabled=true
    writeFileSync(d.globalPath, JSON.stringify({ enabled: true }));

    // Toggle (should flip local default true → false, writing to local)
    const result = toggleEnabled({ home: d.home, cwd: d.cwd });
    expect(result.wroteLocal).toBe(true);
    expect(result.enabled).toBe(false);

    // Read path (local wins) should see false
    expect(readEnabled({ home: d.home, cwd: d.cwd })).toBe(false);
  });
});

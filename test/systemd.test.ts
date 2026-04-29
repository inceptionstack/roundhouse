import { describe, it, expect } from "vitest";
import { generateUnit } from "../src/cli/systemd";

describe("generateUnit", () => {
  const baseOpts = {
    execStart: "/usr/bin/node /usr/bin/roundhouse run",
    nodeBinDir: "/usr/bin",
    user: "testuser",
  };

  it("generates a valid systemd unit", () => {
    const unit = generateUnit(baseOpts);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("User=testuser");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/bin/roundhouse run");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("includes PATH with nodeBinDir", () => {
    const unit = generateUnit(baseOpts);
    expect(unit).toContain("Environment=PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("includes HOME", () => {
    const unit = generateUnit(baseOpts);
    expect(unit).toMatch(/Environment=HOME=\//);
  });

  it("includes EnvironmentFile", () => {
    const unit = generateUnit(baseOpts);
    expect(unit).toMatch(/EnvironmentFile=-.*\.env/);
  });

  it("uses custom envFilePath when provided", () => {
    const unit = generateUnit({ ...baseOpts, envFilePath: "/custom/.env" });
    expect(unit).toContain("EnvironmentFile=-/custom/.env");
  });

  it("falls back to $USER when user not provided", () => {
    const original = process.env.USER;
    process.env.USER = "fallback_user";
    try {
      const unit = generateUnit({ execStart: "/bin/true", nodeBinDir: "/usr/bin" });
      expect(unit).toContain("User=fallback_user");
    } finally {
      process.env.USER = original;
    }
  });

  it("rejects newline in user", () => {
    expect(() => generateUnit({ ...baseOpts, user: "bad\nuser" }))
      .toThrow(/Unsafe value for user/);
  });

  it("rejects carriage return in execStart", () => {
    expect(() => generateUnit({ ...baseOpts, execStart: "cmd\rinjected" }))
      .toThrow(/Unsafe value for execStart/);
  });

  it("rejects newline in nodeBinDir", () => {
    expect(() => generateUnit({ ...baseOpts, nodeBinDir: "/usr\n/bin" }))
      .toThrow(/Unsafe value/);
  });

  it("rejects newline in envFilePath", () => {
    expect(() => generateUnit({ ...baseOpts, envFilePath: "/path\n/env" }))
      .toThrow(/Unsafe value for envFilePath/);
  });

  it("rejects non-string values", () => {
    expect(() => generateUnit({ ...baseOpts, user: undefined as any }))
      .not.toThrow(); // falls back to process.env.USER
    expect(() => generateUnit({ ...baseOpts, execStart: undefined as any }))
      .toThrow(/Missing or non-string/);
  });
});

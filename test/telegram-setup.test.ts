import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// Mock ROUNDHOUSE_DIR before importing pairing module
const origDir = process.env.ROUNDHOUSE_DIR;

describe("pairing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(resolve(tmpdir(), "roundhouse-pairing-test-"));
    // We'll test the functions directly by reimporting with modified paths
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("createPairingNonce generates rh- prefixed hex", async () => {
    const { createPairingNonce } = await import("../src/pairing");
    const nonce = createPairingNonce();
    expect(nonce).toMatch(/^rh-[0-9a-f]{16}$/);
  });

  it("createPairingNonce generates unique values", async () => {
    const { createPairingNonce } = await import("../src/pairing");
    const a = createPairingNonce();
    const b = createPairingNonce();
    expect(a).not.toBe(b);
  });

  it("createPairingLink builds correct deep link", async () => {
    const { createPairingLink } = await import("../src/pairing");
    const link = createPairingLink("my_bot", "rh-abc123");
    expect(link).toBe("https://t.me/my_bot?start=rh-abc123");
  });

  it("isStartForNonce matches /start nonce", async () => {
    const { isStartForNonce } = await import("../src/pairing");
    expect(isStartForNonce("/start rh-abc123", "rh-abc123")).toBe(true);
    expect(isStartForNonce("rh-abc123", "rh-abc123")).toBe(true);
    expect(isStartForNonce("/start rh-wrong", "rh-abc123")).toBe(false);
    expect(isStartForNonce("/start", "rh-abc123")).toBe(false);
    expect(isStartForNonce("hello", "rh-abc123")).toBe(false);
  });

  it("isStartForNonce handles whitespace", async () => {
    const { isStartForNonce } = await import("../src/pairing");
    expect(isStartForNonce("  /start rh-abc123  ", "rh-abc123")).toBe(true);
    expect(isStartForNonce("  rh-abc123  ", "rh-abc123")).toBe(true);
  });
});

describe("setup-logger", () => {
  it("createTextLogger has all methods", async () => {
    const { createTextLogger } = await import("../src/cli/setup-logger");
    const logger = createTextLogger();
    expect(typeof logger.step).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.ok).toBe("function");
    expect(typeof logger.fail).toBe("function");
  });

  it("createJsonLogger emits valid JSON", async () => {
    const { createJsonLogger } = await import("../src/cli/setup-logger");
    const logger = createJsonLogger();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      logger.step(1, 10, "test.event", "Test message", { key: "val" });
      logger.info("info.event", "Info message");
      logger.warn("warn.event", "Warn message");
      logger.error("err.event", "Error message");
      logger.ok("OK message");
      logger.fail("Fail message");
    } finally {
      console.log = origLog;
    }
    expect(lines.length).toBe(6);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeDefined();
      expect(parsed.event).toBeDefined();
      expect(parsed.message).toBeDefined();
    }
  });

  it("JSON logger redacts tokens", async () => {
    const { createJsonLogger } = await import("../src/cli/setup-logger");
    const logger = createJsonLogger();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      logger.error("test", "Token 12345678:AAHtest_secret_token_value failed");
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).not.toContain("AAHtest_secret_token_value");
    expect(parsed.message).toContain("1234...");
  });
});

describe("parseSetupArgs --telegram flags", () => {
  it("parses --telegram flag", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    // Need to set env for token
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts = parseSetupArgs(["--telegram", "--user", "testuser"]);
      expect(opts.telegram).toBe(true);
      expect(opts.headless).toBe(false);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("--headless implies --non-interactive", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts = parseSetupArgs(["--telegram", "--headless", "--user", "testuser"]);
      expect(opts.headless).toBe(true);
      expect(opts.nonInteractive).toBe(true);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("--headless rejects --bot-token", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    expect(() =>
      parseSetupArgs(["--telegram", "--headless", "--bot-token", "fake:token", "--user", "x"])
    ).toThrow("--bot-token is not accepted in --headless mode");
  });

  it("--headless requires --user", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      expect(() =>
        parseSetupArgs(["--telegram", "--headless"])
      ).toThrow("--user");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("--qr and --no-qr flags", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts1 = parseSetupArgs(["--telegram", "--user", "x", "--qr"]);
      expect(opts1.qr).toBe("always");
      const opts2 = parseSetupArgs(["--telegram", "--user", "x", "--no-qr"]);
      expect(opts2.qr).toBe("never");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("interactive --telegram allows no token/user at parse time", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    // Mock TTY
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      // No token, no user — should not throw for interactive --telegram
      const opts = parseSetupArgs(["--telegram"]);
      expect(opts.telegram).toBe(true);
      expect(opts.users).toEqual([]);
      expect(opts.botToken).toBe("");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });
});

describe("parseSetupArgs --agent flag", () => {
  it("defaults agent to pi", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts = parseSetupArgs(["--user", "x"]);
      expect(opts.agent).toBe("pi");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("accepts --agent pi explicitly", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts = parseSetupArgs(["--agent", "pi", "--user", "x"]);
      expect(opts.agent).toBe("pi");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("rejects unknown agent type", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      expect(() => parseSetupArgs(["--agent", "unknown", "--user", "x"]))
        .toThrow(/Unknown agent type/);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("--agent works with --telegram", async () => {
    const { parseSetupArgs } = await import("../src/cli/setup");
    process.env.TELEGRAM_BOT_TOKEN = "fake:token";
    try {
      const opts = parseSetupArgs(["--telegram", "--agent", "pi", "--user", "x"]);
      expect(opts.telegram).toBe(true);
      expect(opts.agent).toBe("pi");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

describe("agent registry", () => {
  it("getAgentDefinition returns pi definition", async () => {
    const { getAgentDefinition } = await import("../src/agents/registry");
    const def = getAgentDefinition("pi");
    expect(def.type).toBe("pi");
    expect(def.name).toBe("Pi");
    expect(def.available).toBe(true);
    expect(def.packages.length).toBeGreaterThan(0);
    expect(def.packages[0].packageName).toBe("@mariozechner/pi-coding-agent");
  });

  it("getAgentDefinition throws for unknown type", async () => {
    const { getAgentDefinition } = await import("../src/agents/registry");
    expect(() => getAgentDefinition("nope")).toThrow(/Unknown agent type.*Available.*pi/);
  });

  it("listAvailableAgentTypes includes pi", async () => {
    const { listAvailableAgentTypes } = await import("../src/agents/registry");
    expect(listAvailableAgentTypes()).toContain("pi");
  });

  it("getAgentFactory returns a function for pi", async () => {
    const { getAgentFactory } = await import("../src/agents/registry");
    expect(typeof getAgentFactory("pi")).toBe("function");
  });

  it("getAgentSdkPackage returns pi package name", async () => {
    const { getAgentSdkPackage } = await import("../src/agents/registry");
    expect(getAgentSdkPackage("pi")).toBe("@mariozechner/pi-coding-agent");
  });
});

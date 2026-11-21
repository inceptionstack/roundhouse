import { describe, it, expect } from "vitest";
import { generatePlist } from "../src/cli/launchd";

describe("launchd", () => {
  it("generates a valid plist with required keys", () => {
    const plist = generatePlist();
    expect(plist).toContain("com.inceptionstack.roundhouse");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("roundhouse.log");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("NODE_NO_WARNINGS");
    expect(plist).toContain("ROUNDHOUSE_CONFIG");
  });

  it("includes node binary in program arguments", () => {
    const plist = generatePlist();
    expect(plist).toMatch(/<string>.*node.*<\/string>/);
  });

  it("escapes XML special characters", () => {
    const plist = generatePlist();
    // PATH contains colons but no unescaped < or >
    expect(plist).not.toMatch(/<string>[^<]*<[^/][^<]*<\/string>/);
  });

  it("keeps npm-injected node_modules/.bin directories out of the service PATH", () => {
    const saved = process.env.PATH;
    process.env.PATH = "/work/project/node_modules/.bin:/work/node_modules/.bin:/opt/homebrew/bin:/usr/bin";
    try {
      const plist = generatePlist();
      const path = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
      expect(path).toBe("/opt/homebrew/bin:/usr/bin");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("sets ThrottleInterval to prevent rapid restarts", () => {
    const plist = generatePlist();
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>5</integer>");
  });
});

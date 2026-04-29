import { describe, it, expect } from "vitest";
import { parseEnvFile, serializeEnvFile, envQuote } from "../src/cli/env-file";

describe("parseEnvFile", () => {
  it("parses key=value lines", () => {
    const result = parseEnvFile('FOO="bar"\nBAZ=qux\n');
    expect(result.get("FOO")).toBe('"bar"');
    expect(result.get("BAZ")).toBe("qux");
  });

  it("skips blank lines and comments", () => {
    const result = parseEnvFile('\n# comment\n\nKEY=val\n  # another\n');
    expect(result.size).toBe(1);
    expect(result.get("KEY")).toBe("val");
  });

  it("handles values with = in them", () => {
    const result = parseEnvFile('TOKEN=abc=def==\n');
    expect(result.get("TOKEN")).toBe("abc=def==");
  });

  it("returns empty map for empty input", () => {
    expect(parseEnvFile("").size).toBe(0);
    expect(parseEnvFile("\n\n").size).toBe(0);
  });
});

describe("serializeEnvFile", () => {
  it("serializes map to env file format", () => {
    const entries = new Map([["A", '"1"'], ["B", '"2"']]);
    expect(serializeEnvFile(entries)).toBe('A="1"\nB="2"\n');
  });

  it("handles empty map", () => {
    expect(serializeEnvFile(new Map())).toBe("\n");
  });
});

describe("envQuote", () => {
  it("wraps simple values in double quotes", () => {
    expect(envQuote("hello")).toBe('"hello"');
  });

  it("escapes backslashes", () => {
    expect(envQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes double quotes", () => {
    expect(envQuote('a"b')).toBe('"a\\"b"');
  });

  it("escapes dollar signs", () => {
    expect(envQuote("$HOME")).toBe('"\\$HOME"');
  });

  it("escapes backticks", () => {
    expect(envQuote("`cmd`")).toBe('"\\`cmd\\`"');
  });

  it("escapes newlines", () => {
    expect(envQuote("line1\nline2")).toBe('"line1\\nline2"');
  });

  it("handles combined special chars", () => {
    const result = envQuote('a\\b"$`\n');
    expect(result).toBe('"a\\\\b\\"\\$\\`\\n"');
  });
});

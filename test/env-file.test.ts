import { describe, it, expect } from "vitest";
import { parseEnvFile, serializeEnvFile, envQuote, unquoteEnvValue } from "../src/cli/env-file";

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

describe("unquoteEnvValue", () => {
  it("strips matched double quotes", () => {
    expect(unquoteEnvValue('"hello"')).toBe("hello");
  });

  it("strips matched single quotes", () => {
    expect(unquoteEnvValue("'hello'")).toBe("hello");
  });

  it("does not strip mismatched quotes", () => {
    expect(unquoteEnvValue('"hello\'')).toBe('"hello\'');
  });

  it("returns unquoted value as-is", () => {
    expect(unquoteEnvValue("plain")).toBe("plain");
  });

  it("unescapes backslashes", () => {
    expect(unquoteEnvValue('"a\\\\b"')).toBe("a\\b");
  });

  it("unescapes double quotes", () => {
    expect(unquoteEnvValue('"say\\"hi\\""')).toBe('say"hi"');
  });

  it("unescapes dollar signs", () => {
    expect(unquoteEnvValue('"pa\\$\\$word"')).toBe("pa$$word");
  });

  it("unescapes backticks", () => {
    expect(unquoteEnvValue('"\\`cmd\\`"')).toBe("`cmd`");
  });

  it("unescapes newlines", () => {
    expect(unquoteEnvValue('"line1\\nline2"')).toBe("line1\nline2");
  });

  it("handles literal backslash-n (not a newline)", () => {
    // envQuote("hello\\nworld") -> "hello\\\\nworld"
    expect(unquoteEnvValue('"hello\\\\nworld"')).toBe("hello\\nworld");
  });
});

describe("envQuote / unquoteEnvValue roundtrip", () => {
  const cases = [
    "simple_token_123",
    "pa$$word",
    'has"quotes"inside',
    "back\\slash",
    "hello\nworld",
    "hello\\nworld",
    'combo: $"`\n',
    "",
    "no_special_chars",
    "trailing\\",
  ];

  for (const original of cases) {
    it(`roundtrips: ${JSON.stringify(original)}`, () => {
      expect(unquoteEnvValue(envQuote(original))).toBe(original);
    });
  }
});

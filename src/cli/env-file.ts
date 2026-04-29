/**
 * cli/env-file.ts — Shared env file parsing and quoting
 *
 * Used by install, setup, status, doctor, and pair commands.
 */

/**
 * Parse a systemd-compatible env file into a key→value map.
 * Skips blank lines and comments (#).
 */
export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return entries;
}

/**
 * Serialize a key→value map to env file content.
 */
export function serializeEnvFile(entries: Map<string, string>): string {
  return [...entries.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/**
 * Shell-escape a value for env files (double-quoted).
 */
export function envQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

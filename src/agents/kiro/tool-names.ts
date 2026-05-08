/**
 * tool-names.ts — Normalize kiro-cli tool titles to canonical names
 *
 * kiro-cli decorates tool titles with human-friendly prefixes.
 * This module strips them for consistent matching.
 */

const TITLE_PREFIXES = ["Running: ", "Reading "] as const;

/** Strip known kiro-cli title prefixes to get the canonical tool name. */
export function normalizeToolName(raw: string): string {
  for (const prefix of TITLE_PREFIXES) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

/**
 * Match a pattern against a tool name.
 * Supports: "*" (all), "prefix*", "*suffix", "*contains*", exact match.
 * Case-insensitive.
 */
export function toolMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p === n) return true;

  // Glob patterns
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
    return n.includes(p.slice(1, -1));
  }
  if (p.endsWith("*")) return n.startsWith(p.slice(0, -1));
  if (p.startsWith("*")) return n.endsWith(p.slice(1));

  return false;
}

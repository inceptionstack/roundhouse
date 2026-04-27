/**
 * cron/durations.ts — Parse human-friendly duration strings
 */

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse "30s", "5m", "6h", "2d" → milliseconds. Throws on invalid input. */
export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: "${input}". Use format like 30s, 5m, 6h, 2d`);
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (value <= 0) throw new Error(`Duration must be positive: "${input}"`);
  return Math.round(value * UNITS[unit]);
}

/** Format milliseconds as human-friendly string */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** Check if a string looks like a duration */
export function isDuration(input: string): boolean {
  return /^\d+(?:\.\d+)?\s*[smhd]$/i.test(input.trim());
}

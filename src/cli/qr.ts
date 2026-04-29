/**
 * cli/qr.ts — Terminal QR code rendering.
 * Wraps qrcode-terminal with graceful fallback.
 */

export type QrMode = "auto" | "always" | "never";

/**
 * Print a QR code to stdout if conditions allow.
 * Falls back silently if the terminal can't render it.
 */
export function printQr(url: string, mode: QrMode = "auto"): void {
  if (mode === "never") return;
  if (mode === "auto" && !process.stdout.isTTY) return;

  try {
    // Dynamic import to keep it optional
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qrcode = require("qrcode-terminal") as { generate: (text: string, opts: { small: boolean }, cb?: (code: string) => void) => void };
    qrcode.generate(url, { small: true });
  } catch {
    // Package not available — skip silently
  }
}

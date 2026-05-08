/**
 * cli/setup-logger.ts — Structured logging for setup.
 *
 * Interactive mode: human-friendly text with step numbers and emoji.
 * Headless mode: JSON lines for SSM/cloud-init/Docker log parsing.
 */

export interface SetupLogger {
  step(n: number, total: number, event: string, message: string, context?: Record<string, unknown>): void;
  info(event: string, message: string, context?: Record<string, unknown>): void;
  warn(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, context?: Record<string, unknown>): void;
  ok(message: string): void;
  fail(message: string): void;
}

const STEP_EMOJI = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function stepLabel(n: number): string {
  return STEP_EMOJI[n - 1] ?? `(${n})`;
}

function ts(): string {
  return new Date().toISOString();
}

/**
 * Redact token-like strings from messages and context values.
 * Catches patterns like "123456:AAH..." (Telegram bot tokens).
 */
function redact(s: string): string {
  return s.replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, (m) => {
    const parts = m.split(":");
    return `${parts[0].slice(0, 4)}...${parts[1]?.slice(-4) ?? ""}`;
  });
}

function redactContext(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  return JSON.parse(redact(JSON.stringify(ctx)));
}

export function createTextLogger(): SetupLogger {
  return {
    step(n, _total, _event, message) {
      console.log(`\n${stepLabel(n)} ${redact(message)}`);
    },
    info(_event, message) {
      console.log(`   ${redact(message)}`);
    },
    warn(_event, message) {
      console.log(`   ⚠ ${redact(message)}`);
    },
    error(_event, message) {
      console.error(`   ❌ ${redact(message)}`);
    },
    ok(message) {
      console.log(`   ✓ ${redact(message)}`);
    },
    fail(message) {
      console.error(`   ✗ ${redact(message)}`);
    },
  };
}

export function createJsonLogger(): SetupLogger {
  function emit(level: string, event: string, message: string, extra?: Record<string, unknown>) {
    const line: Record<string, unknown> = {
      ts: ts(),
      level,
      event,
      message: redact(message),
      ...redactContext(extra),
    };
    console.log(JSON.stringify(line));
  }

  return {
    step(n, total, event, message, context) {
      emit("info", event, message, { step: n, total, ...context });
    },
    info(event, message, context) {
      emit("info", event, message, context);
    },
    warn(event, message, context) {
      emit("warn", event, message, context);
    },
    error(event, message, context) {
      emit("error", event, message, context);
    },
    ok(message) {
      emit("info", "ok", message);
    },
    fail(message) {
      emit("error", "fail", message);
    },
  };
}

/**
 * Collect diagnostic info for error output.
 */
export interface SetupDiagnostics {
  node: string;
  platform: string;
  arch: string;
  cwd: string;
  roundhouseDir: string;
  configExists: boolean;
  envExists: boolean;
  pairingStatus: string;
  serviceState: string;
  error: { name: string; message: string; stack?: string };
}

export function printDiagnosticError(diag: SetupDiagnostics, headless: boolean): void {
  if (headless) {
    console.error(JSON.stringify({
      ts: ts(),
      level: "error",
      event: "setup.failed",
      diagnostics: {
        ...diag,
        error: {
          ...diag.error,
          message: redact(diag.error.message),
          stack: diag.error.stack ? redact(diag.error.stack) : undefined,
        },
      },
    }));
  } else {
    console.error(`\n━━━━━━━━━━━━━━━━━━━`);
    console.error(`❌ Setup failed: ${redact(diag.error.message)}`);
    console.error(`\nDiagnostics:`);
    console.error(`  Node: ${diag.node}`);
    console.error(`  Platform: ${diag.platform} ${diag.arch}`);
    console.error(`  Config: ${diag.configExists ? "exists" : "missing"}`);
    console.error(`  Env file: ${diag.envExists ? "exists" : "missing"}`);
    console.error(`  Pairing: ${diag.pairingStatus}`);
    console.error(`  Service: ${diag.serviceState}`);
  }
}

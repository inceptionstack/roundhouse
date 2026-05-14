export const MAX_CAUSE_CHAIN_DEPTH = 5;

interface ErrorPatternMatchOptions {
  stringifyGate?: (err: unknown) => boolean;
}

/**
 * Stringify-search gate: only walk serialized error fields when the error
 * looks like a 4xx / Bedrock ValidationException. Avoids false-positives
 * from unrelated 5xx noise that happens to contain trigger phrases.
 */
function looksLikeValidationError(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  const httpStatus =
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'ValidationException' || httpStatus === 400;
}

export function matchesErrorPatterns(
  err: unknown,
  patterns: RegExp[],
  options: ErrorPatternMatchOptions = {},
): boolean {
  if (!err) return false;

  const matches = (value: unknown): boolean => {
    const message = (value as { message?: string }).message ?? String(value);
    return patterns.some(pattern => pattern.test(message));
  };

  if (matches(err)) return true;

  let current: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current; depth++) {
    if (matches(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }

  if (!options.stringifyGate?.(err)) {
    return false;
  }

  try {
    const serialized = JSON.stringify(err);
    return patterns.some(pattern => pattern.test(serialized));
  } catch {
    return false;
  }
}

export function isContextOverflowError(err: unknown): boolean {
  const patterns = [
    /prompt is too long/i,
    /tokens?\s*[>>]\s*\d+\s*maximum/i,
    /input is too long/i,
    /context length exceeded/i,
    /maximum context length/i,
  ];
  return matchesErrorPatterns(err, patterns, { stringifyGate: looksLikeValidationError });
}

export function isToolPairingError(err: unknown): boolean {
  const patterns = [
    /tool_use.*without.*tool_result/i,
    /tool_result.*without.*tool_use/i,
    /toolUse.*without.*toolResult/i,
    /unmatched.*tool.?use/i,
    /orphan.*tool/i,
  ];
  return matchesErrorPatterns(err, patterns, { stringifyGate: looksLikeValidationError });
}

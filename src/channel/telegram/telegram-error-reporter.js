const TRANSIENT_NETWORK_PATTERNS = [
  /Client network socket disconnected before secure TLS connection was established/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /ETIMEDOUT/i
];

export function normalizeTelegramNetworkError(error) {
  const messages = [];
  let current = error;
  while (current) {
    const msg = current?.message ?? String(current);
    if (msg && !messages.includes(msg)) messages.push(msg);
    current = current?.cause;
  }
  const full = messages.join(' → ');
  if (TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(full))) {
    return `Transient proxy/TLS issue: ${full}`;
  }
  return full;
}

export function createTelegramPollingErrorReporter({ logger, windowMs = 60_000 } = {}) {
  const state = new Map();

  return (error) => {
    const normalized = normalizeTelegramNetworkError(error);
    const now = Date.now();
    const entry = state.get(normalized);

    if (entry && (now - entry.lastAt) < windowMs) {
      entry.suppressed += 1;
      return;
    }

    const suffix = entry?.suppressed
      ? ` (suppressed ${entry.suppressed} similar errors in the last ${Math.round(windowMs / 1000)}s)`
      : '';

    state.set(normalized, { lastAt: now, suppressed: 0 });
    logger?.warn?.(`[telegram.polling] ${normalized}${suffix}`);
  };
}

// Retry with exponential backoff (Issue 7, Day 7).
//
//   await withRetry(() => fetchSheets(args), {
//     attempts: 3,
//     label: "extractor: Google Sheets",
//     shouldRetry: (err) => !err.status || err.status >= 500,
//     onRetry: (err, attempt, delayMs) => log.warn("retry", { attempt, delay_ms: delayMs, message: err.message }),
//   });
//
// Retries are for transient failures only: pass a shouldRetry predicate that
// returns false for deterministic errors (HTTP 4xx), which fail immediately.

"use strict";

async function withRetry(fn, options = {}) {
  const { attempts = 3, baseDelayMs = 250, label = "operation", shouldRetry = () => true, onRetry } = options;

  let lastErr;
  let tried = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    tried = attempt;
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err)) break;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      if (onRetry) onRetry(err, attempt, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const error = new Error(`${label} failed after ${tried} attempt(s): ${lastErr.message}`);
  error.cause = lastErr;
  error.status = lastErr.status;
  throw error;
}

module.exports = { withRetry };

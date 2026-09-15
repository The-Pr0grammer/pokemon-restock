function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
    reason.code = reason.code || 'SOURCE_TIMEOUT';
    throw reason;
  }
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const reason = signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
      reason.code = reason.code || 'SOURCE_TIMEOUT';
      reject(reason);
    }, { once: true });
  });
}

/**
 * Calls fn(attempt) up to maxAttempts times with exponential backoff between failures.
 *
 * @param {function(number): Promise<any>} fn       Called with 1-based attempt number
 * @param {object}   opts
 * @param {number}   opts.maxAttempts               Total attempts (default 3)
 * @param {number}   opts.baseDelayMs               Base delay; doubles each retry (default 1000)
 * @param {function(Error): boolean} [opts.isRetryable]  Return false to throw immediately
 * @param {function(Error,number,number): number} [opts.getDelay]  Override delay calculation
 * @param {function(Error,number,number): void}  [opts.onRetry]   Called before each sleep
 */
async function withRetry(fn, opts = {}) {
  const { maxAttempts = 3, baseDelayMs = 1000, isRetryable, getDelay, onRetry, signal } = opts;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      throwIfAborted(signal);
      if (isRetryable && !isRetryable(err)) throw err;  // permanent error — rethrow immediately
      const delayMs = getDelay
        ? getDelay(err, attempt, baseDelayMs)
        : baseDelayMs * (2 ** (attempt - 1));            // 1×, 2×, 4× …
      onRetry?.(err, attempt, delayMs);
      await sleep(delayMs, signal);
    }
  }

  throw lastErr;
}

module.exports = { withRetry, sleep, throwIfAborted };

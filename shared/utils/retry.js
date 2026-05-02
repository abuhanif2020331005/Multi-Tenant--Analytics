/**
 * Exponential backoff retry utility.
 *
 * Usage:
 *   const result = await withRetry(() => fetchSomething(), {
 *     attempts: 3,
 *     baseDelayMs: 200,
 *     maxDelayMs: 5000,
 *     shouldRetry: (err) => err.status >= 500,
 *   });
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.2);
}

async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 10_000,
    factor = 2,
    shouldRetry = () => true,
    onRetry = null,
    logger = null,
    operationName = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const isLast = attempt === attempts;
      const retryable = !isLast && shouldRetry(error, attempt);

      if (!retryable) {
        throw error;
      }

      const delayMs = jitter(Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs));

      logger?.warn('retry_scheduled', {
        operationName,
        attempt,
        maxAttempts: attempts,
        delayMs,
        error: error.message,
      });

      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = { withRetry };

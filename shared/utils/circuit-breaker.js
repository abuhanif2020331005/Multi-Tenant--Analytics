/**
 * Lightweight circuit breaker for inter-service calls.
 *
 * States:
 *   CLOSED   – requests pass through normally
 *   OPEN     – requests fail fast without calling the upstream
 *   HALF_OPEN – one probe request is allowed; success closes, failure re-opens
 */

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

function createCircuitBreaker(options = {}) {
  const {
    name = 'unnamed',
    failureThreshold = 5,       // consecutive failures before opening
    successThreshold = 2,       // consecutive successes in HALF_OPEN before closing
    timeout = 30_000,           // ms to wait in OPEN before moving to HALF_OPEN
    callTimeout = 10_000,       // ms before a single call is considered failed
    logger = null,
  } = options;

  let state = STATE.CLOSED;
  let failureCount = 0;
  let successCount = 0;
  let openedAt = null;
  let halfOpenProbeInFlight = false;

  const stats = {
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    rejectedCalls: 0,
    stateChanges: [],
  };

  function transition(nextState) {
    if (state === nextState) return;
    const prev = state;
    state = nextState;
    stats.stateChanges.push({ from: prev, to: nextState, at: new Date().toISOString() });
    logger?.info('circuit_breaker_state_change', { name, from: prev, to: nextState });
  }

  function withCallTimeout(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Circuit breaker call timeout after ${callTimeout}ms`)),
        callTimeout
      );
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  async function call(fn) {
    stats.totalCalls += 1;

    // OPEN: check if timeout has elapsed to move to HALF_OPEN
    if (state === STATE.OPEN) {
      if (Date.now() - openedAt >= timeout) {
        transition(STATE.HALF_OPEN);
        halfOpenProbeInFlight = false;
        successCount = 0;
      } else {
        stats.rejectedCalls += 1;
        const error = new Error(`Circuit breaker [${name}] is OPEN – request rejected`);
        error.circuitOpen = true;
        throw error;
      }
    }

    // HALF_OPEN: only allow one probe at a time
    if (state === STATE.HALF_OPEN && halfOpenProbeInFlight) {
      stats.rejectedCalls += 1;
      const error = new Error(`Circuit breaker [${name}] is HALF_OPEN – probe already in flight`);
      error.circuitOpen = true;
      throw error;
    }

    if (state === STATE.HALF_OPEN) {
      halfOpenProbeInFlight = true;
    }

    try {
      const result = await withCallTimeout(fn());
      stats.successCalls += 1;
      failureCount = 0;

      if (state === STATE.HALF_OPEN) {
        successCount += 1;
        halfOpenProbeInFlight = false;
        if (successCount >= successThreshold) {
          successCount = 0;
          transition(STATE.CLOSED);
        }
      }

      return result;
    } catch (error) {
      stats.failedCalls += 1;
      failureCount += 1;

      if (state === STATE.HALF_OPEN) {
        halfOpenProbeInFlight = false;
        successCount = 0;
        openedAt = Date.now();
        transition(STATE.OPEN);
      } else if (state === STATE.CLOSED && failureCount >= failureThreshold) {
        openedAt = Date.now();
        transition(STATE.OPEN);
      }

      throw error;
    }
  }

  return {
    call,
    get state() { return state; },
    get stats() {
      return {
        ...stats,
        state,
        failureCount,
        successCount,
        openedAt,
      };
    },
    reset() {
      state = STATE.CLOSED;
      failureCount = 0;
      successCount = 0;
      openedAt = null;
      halfOpenProbeInFlight = false;
    },
  };
}

/**
 * Registry so services can share named breakers.
 */
function createCircuitBreakerRegistry(defaultOptions = {}) {
  const breakers = new Map();

  return {
    get(name, overrides = {}) {
      if (!breakers.has(name)) {
        breakers.set(name, createCircuitBreaker({ name, ...defaultOptions, ...overrides }));
      }
      return breakers.get(name);
    },
    snapshot() {
      const result = {};
      for (const [name, breaker] of breakers.entries()) {
        result[name] = breaker.stats;
      }
      return result;
    },
  };
}

module.exports = { createCircuitBreaker, createCircuitBreakerRegistry, STATE };

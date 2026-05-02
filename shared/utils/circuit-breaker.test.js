const { createCircuitBreaker, createCircuitBreakerRegistry, STATE } = require('./circuit-breaker');

describe('CircuitBreaker', () => {
  it('starts CLOSED and passes calls through', async () => {
    const cb = createCircuitBreaker({ name: 'test' });
    expect(cb.state).toBe(STATE.CLOSED);
    const result = await cb.call(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.stats.successCalls).toBe(1);
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 2 });

    for (let i = 0; i < 2; i++) {
      await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    }

    expect(cb.state).toBe(STATE.OPEN);
  });

  it('rejects calls fast when OPEN', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 1 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});

    const err = await cb.call(async () => 'should not run').catch((e) => e);
    expect(err.circuitOpen).toBe(true);
    expect(cb.stats.rejectedCalls).toBe(1);
  });

  it('moves to HALF_OPEN after timeout', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 10 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN);

    await new Promise((r) => setTimeout(r, 20));
    // Next call should trigger HALF_OPEN transition
    await cb.call(async () => 'probe').catch(() => {});
    // After successful probe, should be CLOSED (successThreshold=2 by default, so still HALF_OPEN after 1)
    expect([STATE.HALF_OPEN, STATE.CLOSED]).toContain(cb.state);
  });

  it('closes after successThreshold successes in HALF_OPEN', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 10, successThreshold: 2 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    await cb.call(async () => 'probe1');
    expect(cb.state).toBe(STATE.HALF_OPEN);
    await cb.call(async () => 'probe2');
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('re-opens on failure in HALF_OPEN', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 10 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    await cb.call(async () => { throw new Error('still failing'); }).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN);
  });

  it('reset() returns to CLOSED', async () => {
    const cb = createCircuitBreaker({ name: 'test', failureThreshold: 1 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN);
    cb.reset();
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('times out slow calls', async () => {
    const cb = createCircuitBreaker({ name: 'test', callTimeout: 50 });
    const err = await cb.call(() => new Promise((r) => setTimeout(r, 200))).catch((e) => e);
    expect(err.message).toMatch(/timeout/i);
  });
});

describe('CircuitBreakerRegistry', () => {
  it('returns same breaker for same name', () => {
    const registry = createCircuitBreakerRegistry();
    const a = registry.get('svc-a');
    const b = registry.get('svc-a');
    expect(a).toBe(b);
  });

  it('snapshot returns stats for all breakers', async () => {
    const registry = createCircuitBreakerRegistry();
    await registry.get('svc-x').call(async () => 'ok');
    const snap = registry.snapshot();
    expect(snap['svc-x'].successCalls).toBe(1);
  });
});

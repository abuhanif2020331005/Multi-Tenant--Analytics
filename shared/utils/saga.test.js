const { createSaga } = require('./saga');

describe('Saga', () => {
  it('executes all steps and returns results', async () => {
    const saga = createSaga('test');
    saga.addStep('step1', async (ctx) => { ctx.x = 1; return 'r1'; }, null);
    saga.addStep('step2', async (ctx) => { ctx.y = 2; return 'r2'; }, null);

    const results = await saga.execute({});
    expect(results.step1).toBe('r1');
    expect(results.step2).toBe('r2');
  });

  it('compensates completed steps in reverse order on failure', async () => {
    const compensated = [];
    const saga = createSaga('test');
    saga.addStep('step1', async () => 's1', async () => compensated.push('comp1'));
    saga.addStep('step2', async () => 's2', async () => compensated.push('comp2'));
    saga.addStep('step3', async () => { throw new Error('step3 failed'); }, null);

    await expect(saga.execute({})).rejects.toThrow('step3 failed');
    expect(compensated).toEqual(['comp2', 'comp1']); // reverse order
  });

  it('attaches saga metadata to thrown error', async () => {
    const saga = createSaga('my-saga');
    saga.addStep('bad', async () => { throw new Error('oops'); }, null);

    const err = await saga.execute({}).catch((e) => e);
    expect(err.sagaName).toBe('my-saga');
    expect(err.failedStep).toBe('bad');
    expect(err.originalError.message).toBe('oops');
  });

  it('skips null compensate functions', async () => {
    const saga = createSaga('test');
    saga.addStep('step1', async () => 'ok', null); // no compensate
    saga.addStep('step2', async () => { throw new Error('fail'); }, null);

    // Should not throw during compensation
    await expect(saga.execute({})).rejects.toThrow('fail');
  });

  it('passes context and previous results to each step', async () => {
    const saga = createSaga('test');
    const ctx = { tenantId: 'acme' };
    let capturedResults;

    saga.addStep('step1', async () => 42, null);
    saga.addStep('step2', async (c, results) => {
      capturedResults = results;
      return results.step1 * 2;
    }, null);

    const final = await saga.execute(ctx);
    expect(capturedResults.step1).toBe(42);
    expect(final.step2).toBe(84);
  });
});

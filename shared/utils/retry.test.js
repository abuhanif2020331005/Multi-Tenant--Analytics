const { withRetry } = require('./retry');

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(async () => 'done', { attempts: 3 });
    expect(result).toBe('done');
  });

  it('retries and succeeds on 3rd attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'success';
      },
      { attempts: 3, baseDelayMs: 5 }
    );
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('throws after exhausting all attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error('always fails'); },
        { attempts: 3, baseDelayMs: 5 }
      )
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });

  it('does not retry when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error('fatal'); },
        { attempts: 5, baseDelayMs: 5, shouldRetry: () => false }
      )
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('calls onRetry callback with error and attempt number', async () => {
    const retries = [];
    await withRetry(
      async (n) => { if (n < 3) throw new Error(`attempt ${n}`); return 'ok'; },
      { attempts: 3, baseDelayMs: 5, onRetry: (err, attempt) => retries.push({ err: err.message, attempt }) }
    );
    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[1].attempt).toBe(2);
  });
});

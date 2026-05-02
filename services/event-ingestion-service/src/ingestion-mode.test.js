const { normalizeIngestionMode, shouldQueueEvents } = require('./ingestion-mode');

describe('ingestion mode selection', () => {
  test.each([
    ['direct', 'direct', false],
    ['outbox', 'outbox', true],
    ['broker', 'broker', true],
    ['BROKER', 'broker', true],
    [undefined, 'outbox', true],
    ['unknown', 'outbox', true],
  ])('normalizes %p to %p', (input, expectedMode, expectedQueued) => {
    const result = normalizeIngestionMode(input);

    expect(result.normalizedMode).toBe(expectedMode);
    expect(shouldQueueEvents(result.normalizedMode)).toBe(expectedQueued);
  });

  test('reports fallback usage for invalid values', () => {
    expect(normalizeIngestionMode('nonsense')).toMatchObject({
      requestedMode: 'nonsense',
      normalizedMode: 'outbox',
      usedFallback: true,
    });
  });
});

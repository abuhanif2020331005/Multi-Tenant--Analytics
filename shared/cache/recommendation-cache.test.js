const { createRecommendationCache } = require('./recommendation-cache');

function mockRedisClient(overrides = {}) {
  const store = new Map();
  return {
    enabled: true,
    get connected() { return true; },
    client: {
      get: jest.fn(async (key) => store.get(key) || null),
      set: jest.fn(async (key, value) => { store.set(key, value); }),
      keys: jest.fn(async (pattern) => {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return [...store.keys()].filter((k) => regex.test(k));
      }),
      del: jest.fn(async (keys) => { keys.forEach((k) => store.delete(k)); }),
      ...overrides,
    },
  };
}

describe('createRecommendationCache', () => {
  it('calls fetchFn on cache miss and returns result', async () => {
    const redis = mockRedisClient();
    const cache = createRecommendationCache(redis, null);
    const fetchFn = jest.fn(async () => ({ data: 'fresh' }));

    const result = await cache.get('key1', 60, fetchFn);
    expect(result).toEqual({ data: 'fresh' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns cached value on second call without calling fetchFn', async () => {
    const redis = mockRedisClient();
    const cache = createRecommendationCache(redis, null);
    const fetchFn = jest.fn(async () => ({ data: 'fresh' }));

    await cache.get('key2', 60, fetchFn);
    // Simulate cache hit by pre-populating
    redis.client.get.mockResolvedValueOnce(JSON.stringify({ data: 'cached' }));
    const result = await cache.get('key2', 60, fetchFn);

    expect(result).toEqual({ data: 'cached' });
    expect(fetchFn).toHaveBeenCalledTimes(1); // only called once
  });

  it('falls back to fetchFn when Redis errors', async () => {
    const redis = mockRedisClient({
      get: jest.fn(async () => { throw new Error('redis down'); }),
    });
    const cache = createRecommendationCache(redis, null);
    const fetchFn = jest.fn(async () => ({ data: 'fallback' }));

    const result = await cache.get('key3', 60, fetchFn);
    expect(result).toEqual({ data: 'fallback' });
  });

  it('invalidate removes matching keys', async () => {
    const redis = mockRedisClient();
    const cache = createRecommendationCache(redis, null);

    // Pre-populate
    redis.client.get.mockResolvedValueOnce(null);
    await cache.get('rec:tenant1:popular:10:30', 60, async () => ({ r: 1 }));

    const count = await cache.invalidate('rec:tenant1:*');
    expect(redis.client.del).toHaveBeenCalled();
  });

  it('tenantKey generates correct key format', () => {
    const cache = createRecommendationCache({ enabled: false }, null);
    const key = cache.tenantKey('t1', 'popular', '10:30');
    expect(key).toBe('rec:t1:popular:10:30');
  });

  it('is disabled when redis client is not enabled', async () => {
    const cache = createRecommendationCache({ enabled: false }, null);
    const fetchFn = jest.fn(async () => ({ data: 'direct' }));
    const result = await cache.get('key', 60, fetchFn);
    expect(result).toEqual({ data: 'direct' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

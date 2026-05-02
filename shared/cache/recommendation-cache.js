/**
 * Cache-aside helper for recommendation data.
 * Wraps any async fetch with Redis TTL caching.
 *
 * Usage:
 *   const cache = createRecommendationCache(redisClient, logger);
 *   const data  = await cache.get(key, ttlSeconds, () => fetchFromDB());
 */

function createRecommendationCache(redisClient, logger) {
  const enabled = redisClient?.enabled && redisClient?.connected;

  async function get(key, ttlSeconds, fetchFn) {
    // Try cache first
    if (enabled && redisClient.connected) {
      try {
        const cached = await redisClient.client.get(key);
        if (cached) {
          logger?.info('cache_hit', { key });
          return JSON.parse(cached);
        }
      } catch (err) {
        logger?.warn('cache_read_error', { key, error: err.message });
      }
    }

    // Cache miss — fetch from source
    const data = await fetchFn();

    // Write to cache (fire-and-forget)
    if (enabled && redisClient.connected) {
      redisClient.client
        .set(key, JSON.stringify(data), { EX: ttlSeconds })
        .catch((err) => logger?.warn('cache_write_error', { key, error: err.message }));
    }

    return data;
  }

  async function invalidate(pattern) {
    if (!enabled || !redisClient.connected) return 0;
    try {
      const keys = await redisClient.client.keys(pattern);
      if (keys.length > 0) {
        await redisClient.client.del(keys);
        logger?.info('cache_invalidated', { pattern, count: keys.length });
      }
      return keys.length;
    } catch (err) {
      logger?.warn('cache_invalidate_error', { pattern, error: err.message });
      return 0;
    }
  }

  function tenantKey(tenantId, type, params = '') {
    return `rec:${tenantId}:${type}:${params}`;
  }

  return { get, invalidate, tenantKey, enabled };
}

module.exports = { createRecommendationCache };

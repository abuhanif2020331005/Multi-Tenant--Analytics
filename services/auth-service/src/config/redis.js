/**
 * Redis client for auth-service (session store, token blacklist).
 * Uses the shared optional client so the service starts even if Redis is down.
 */
const { createOptionalRedisClient } = require('../../../../shared/cache/redis');

const redisClient = createOptionalRedisClient();

// Connect eagerly — failures are logged but don't crash the service
redisClient.connect().catch(() => {});

module.exports = redisClient;

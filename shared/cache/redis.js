const { createRequire } = require('module');

function resolveRedisModule() {
  try {
    return require('redis');
  } catch (localError) {
    try {
      const serviceRequire = createRequire(`${process.cwd()}/package.json`);
      return serviceRequire('redis');
    } catch (serviceError) {
      return null;
    }
  }
}

function createOptionalRedisClient(options = {}) {
  const redisModule = resolveRedisModule();
  if (!redisModule) {
    return {
      enabled: false,
      connected: false,
      reason: 'redis dependency is not installed',
      client: null,
      async connect() {},
      async quit() {},
    };
  }

  const host = options.host || process.env.REDIS_HOST || 'localhost';
  const port = Number(options.port || process.env.REDIS_PORT || 6379);
  const logger = options.logger;
  const client = redisModule.createClient({
    socket: {
      host,
      port,
    },
  });

  let connected = false;

  client.on('connect', () => {
    connected = true;
    logger?.info('redis_connected', { host, port });
  });

  client.on('error', (error) => {
    connected = false;
    logger?.warn('redis_error', {
      host,
      port,
      error: {
        message: error.message,
      },
    });
  });

  return {
    enabled: true,
    reason: null,
    client,
    get connected() {
      return connected && client.isOpen;
    },
    async connect() {
      if (!client.isOpen) {
        await client.connect();
      }
    },
    async quit() {
      if (client.isOpen) {
        await client.quit();
      }
      connected = false;
    },
  };
}

module.exports = {
  createOptionalRedisClient,
};

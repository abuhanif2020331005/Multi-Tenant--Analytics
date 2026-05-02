/**
 * PostgreSQL pool factory with structured logging and startup retry.
 *
 * Retries the initial connection up to CONNECT_RETRIES times with
 * exponential backoff so services survive a slow Postgres startup.
 */

const CONNECT_RETRIES = Number(process.env.DB_CONNECT_RETRIES || 10);
const CONNECT_RETRY_DELAY_MS = Number(process.env.DB_CONNECT_RETRY_DELAY_MS || 2000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPgPool(Pool, serviceName) {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'platform_user',
    password: process.env.DB_PASSWORD || 'platform_pass',
    database: process.env.DB_NAME || 'platform_db',
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('connect', () => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: serviceName, event: 'db_connected' }));
  });

  pool.on('error', (err) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service: serviceName, event: 'db_pool_error', error: err.message }));
  });

  // Warm up the pool with retry on startup
  (async () => {
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        const client = await pool.connect();
        client.release();
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: serviceName, event: 'db_pool_ready', attempt }));
        return;
      } catch (err) {
        const isLast = attempt === CONNECT_RETRIES;
        console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', service: serviceName, event: 'db_connect_retry', attempt, maxAttempts: CONNECT_RETRIES, error: err.message }));
        if (isLast) {
          console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service: serviceName, event: 'db_connect_failed', error: err.message }));
          process.exit(1);
        }
        await sleep(CONNECT_RETRY_DELAY_MS * attempt);
      }
    }
  })();

  return pool;
}

module.exports = { createPgPool };

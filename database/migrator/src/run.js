const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '..', '..', 'migrations');
const SKIP_FILES = new Set(
  String(process.env.MIGRATION_SKIP_FILES || 'init.sql')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'db-migrator',
      event,
      ...fields,
    })
  );
}

function getPool() {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'platform_user',
    password: process.env.DB_PASSWORD || 'platform_pass',
    database: process.env.DB_NAME || 'platform_db',
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => !SKIP_FILES.has(name))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((row) => row.filename));
}

async function applyMigration(client, filename) {
  const migrationPath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    log('migration_applied', { filename });
  } catch (error) {
    await client.query('ROLLBACK');
    log('migration_failed', {
      filename,
      error: {
        message: error.message,
      },
    });
    throw error;
  }
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureSchemaMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const migrationFiles = listMigrationFiles();

    log('migration_scan_complete', {
      directory: MIGRATIONS_DIR,
      discovered: migrationFiles.length,
      skipped: Array.from(SKIP_FILES),
    });

    let appliedCount = 0;
    for (const filename of migrationFiles) {
      if (applied.has(filename)) {
        continue;
      }

      await applyMigration(client, filename);
      appliedCount += 1;
    }

    log('migrations_complete', {
      appliedCount,
      totalDiscovered: migrationFiles.length,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  log('migrator_exit_failed', {
    error: {
      message: error.message,
      stack: error.stack,
    },
  });
  process.exit(1);
});

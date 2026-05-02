require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { Pool } = require('pg');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRedpandaBroker } = require('../../../shared/broker/redpanda');
const { attachContext } = require('../../../shared/middleware/request-context');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const {
  createMetricsStore,
  renderPrometheusMetrics,
  trackNodeRequest,
} = require('../../../shared/observability/http');

validateEnv('event-processor-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'OUTBOX_BATCH_SIZE',
  'OUTBOX_POLL_INTERVAL_MS',
]);

const pool = createPgPool(Pool, 'event-processor-service');
const port = Number(process.env.PORT || 8007);
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE || 50);
const pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 5000);
const maxRetryCount = Number(process.env.OUTBOX_MAX_RETRY_COUNT || 3);
const brokerEnabled = String(process.env.BROKER_ENABLED || 'false').toLowerCase() === 'true';
const brokerTopic = process.env.KAFKA_TOPIC || 'user-events';
const metrics = createMetricsStore('event-processor-service');
const logger = createLogger('event-processor-service');
const broker = createRedpandaBroker({
  clientId: 'event-processor-service',
  logger,
  topic: brokerTopic,
  groupId: process.env.KAFKA_CONSUMER_GROUP || 'event-processor-service-group',
});
const runtimeStats = {
  startedAt: new Date().toISOString(),
  lastBatchAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastPublishedAt: null,
  lastConsumedAt: null,
  processedBatches: 0,
  processedEvents: 0,
  failedEvents: 0,
  publishedEvents: 0,
  consumedEvents: 0,
  brokerPublishFailures: 0,
  brokerConsumeFailures: 0,
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function getQueueStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      COUNT(*) FILTER (WHERE status = 'publish_failed') AS publish_failed_count,
      COUNT(*) FILTER (WHERE status = 'brokered') AS brokered_count,
      COUNT(*) FILTER (WHERE status = 'processed') AS processed_count,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      COUNT(*) FILTER (WHERE status = 'dead_lettered') AS dead_lettered_count,
      COALESCE(MAX(processed_at), NULL) AS latest_processed_at
    FROM event_outbox
  `);

  return {
    pendingCount: Number(result.rows[0].pending_count || 0),
    publishFailedCount: Number(result.rows[0].publish_failed_count || 0),
    brokeredCount: Number(result.rows[0].brokered_count || 0),
    processedCount: Number(result.rows[0].processed_count || 0),
    failedCount: Number(result.rows[0].failed_count || 0),
    deadLetteredCount: Number(result.rows[0].dead_lettered_count || 0),
    latestProcessedAt: result.rows[0].latest_processed_at,
  };
}

async function markDeadLetter(client, row, reason, originalStatus) {
  await client.query(
    `
      UPDATE event_outbox
      SET
        status = 'dead_lettered',
        retry_count = retry_count + 1,
        error_message = LEFT($2, 500)
      WHERE id = $1
    `,
    [row.id, reason]
  );

  await client.query(
    `
      INSERT INTO event_dead_letter (
        outbox_id,
        tenant_id,
        user_id,
        event_type,
        event_payload,
        failure_reason,
        original_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [row.id, row.tenant_id, row.user_id, row.event_type, row.event_payload, reason, originalStatus]
  );
}

function buildBrokerMessage(row) {
  return {
    key: row.tenant_id,
    headers: {
      'x-outbox-id': row.id,
      'x-tenant-id': row.tenant_id,
      'x-event-type': row.event_type,
    },
    value: {
      outboxId: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      eventType: row.event_type,
      eventPayload: row.event_payload,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      occurredAt: row.occurred_at,
      source: row.source,
      createdAt: row.created_at,
    },
  };
}

async function publishPendingBatch() {
  if (!broker.enabled) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const outboxResult = await client.query(
      `
        SELECT id, tenant_id, user_id, event_type, event_payload, ip_address, user_agent, occurred_at, source, created_at, retry_count
        FROM event_outbox
        WHERE status IN ('pending', 'publish_failed')
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [batchSize]
    );

    if (outboxResult.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    try {
      const messages = outboxResult.rows.map(buildBrokerMessage);
      await broker.publishBatch(messages);

      const ids = outboxResult.rows.map((row) => row.id);
      await client.query(
        `
          UPDATE event_outbox
          SET status = 'brokered', error_message = NULL
          WHERE id = ANY($1::uuid[])
        `,
        [ids]
      );

      await client.query('COMMIT');
      runtimeStats.publishedEvents += outboxResult.rows.length;
      runtimeStats.lastPublishedAt = new Date().toISOString();
      runtimeStats.lastBatchAt = runtimeStats.lastPublishedAt;
      runtimeStats.lastSuccessAt = runtimeStats.lastPublishedAt;
      runtimeStats.processedBatches += 1;
      return outboxResult.rows.length;
    } catch (error) {
      for (const row of outboxResult.rows) {
        const nextRetryCount = Number(row.retry_count || 0) + 1;
        if (nextRetryCount >= maxRetryCount) {
          await markDeadLetter(client, row, error.message || 'Failed to publish broker message', 'publish_failed');
        } else {
          await client.query(
            `
              UPDATE event_outbox
              SET
                status = 'publish_failed',
                retry_count = retry_count + 1,
                error_message = LEFT($2, 500)
              WHERE id = $1
            `,
            [row.id, error.message || 'Failed to publish broker message']
          );
        }
      }

      await client.query('COMMIT');
      runtimeStats.brokerPublishFailures += outboxResult.rows.length;
      runtimeStats.failedEvents += outboxResult.rows.length;
      throw error;
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processBatch() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const outboxResult = await client.query(
      `
        SELECT id, tenant_id, user_id, event_type, event_payload, ip_address, user_agent, occurred_at, retry_count
        FROM event_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [batchSize]
    );

    if (outboxResult.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    for (const row of outboxResult.rows) {
      try {
        await client.query(
          `
            INSERT INTO events (
              tenant_id,
              user_id,
              event_type,
              event_data,
              ip_address,
              user_agent,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
          `,
          [
            row.tenant_id,
            row.user_id,
            row.event_type,
            row.event_payload,
            row.ip_address,
            row.user_agent,
            row.occurred_at,
          ]
        );

        await client.query(
          `
            UPDATE event_outbox
            SET status = 'processed', processed_at = NOW(), error_message = NULL
            WHERE id = $1
          `,
          [row.id]
        );
        runtimeStats.processedEvents += 1;
      } catch (error) {
        const nextRetryCount = Number(row.retry_count || 0) + 1;
        const nextStatus = nextRetryCount >= maxRetryCount ? 'dead_lettered' : 'failed';

        await client.query(
          `
            UPDATE event_outbox
            SET
              status = $2,
              retry_count = retry_count + 1,
              error_message = LEFT($3, 500)
            WHERE id = $1
          `,
          [row.id, nextStatus, error.message || 'Unknown processing error']
        );

        if (nextStatus === 'dead_lettered') {
          await client.query(
            `
              INSERT INTO event_dead_letter (
                outbox_id,
                tenant_id,
                user_id,
                event_type,
                event_payload,
                failure_reason,
                original_status
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              row.id,
              row.tenant_id,
              row.user_id,
              row.event_type,
              row.event_payload,
              error.message || 'Unknown processing error',
              'failed',
            ]
          );
        }

        runtimeStats.failedEvents += 1;
      }
    }

    await client.query('COMMIT');
    runtimeStats.lastBatchAt = new Date().toISOString();
    runtimeStats.lastSuccessAt = runtimeStats.lastBatchAt;
    runtimeStats.processedBatches += 1;
    return outboxResult.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runLoop() {
  try {
    if (broker.enabled) {
      const published = await publishPendingBatch();
      if (published > 0) {
        logger.info('outbox_batch_published', {
          published,
          processedBatches: runtimeStats.processedBatches,
          publishedEvents: runtimeStats.publishedEvents,
        });
      }
    } else {
      const processed = await processBatch();
      if (processed > 0) {
        logger.info('outbox_batch_processed', {
          processed,
          processedBatches: runtimeStats.processedBatches,
          processedEvents: runtimeStats.processedEvents,
        });
      }
    }
  } catch (error) {
    runtimeStats.lastErrorAt = new Date().toISOString();
    logger.error('processing_loop_failed', {
      error: serializeError(error),
    });
  } finally {
    setTimeout(runLoop, pollIntervalMs);
  }
}

async function consumeBrokerMessage(message) {
  const payload = message.value || {};
  const outboxId = payload.outboxId;
  if (!outboxId) {
    runtimeStats.brokerConsumeFailures += 1;
    logger.warn('broker_message_missing_outbox_id', {
      topic: message.topic,
      offset: message.offset,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outboxResult = await client.query(
      `
        SELECT id, tenant_id, user_id, event_type, event_payload, ip_address, user_agent, occurred_at, status, retry_count
        FROM event_outbox
        WHERE id = $1
        FOR UPDATE
      `,
      [outboxId]
    );

    if (outboxResult.rows.length === 0) {
      await client.query('COMMIT');
      return;
    }

    const row = outboxResult.rows[0];
    if (row.status === 'processed') {
      await client.query('COMMIT');
      return;
    }

    try {
      await client.query(
        `
          INSERT INTO events (
            tenant_id,
            user_id,
            event_type,
            event_data,
            ip_address,
            user_agent,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
        `,
        [
          row.tenant_id,
          row.user_id,
          row.event_type,
          row.event_payload,
          row.ip_address,
          row.user_agent,
          row.occurred_at,
        ]
      );

      await client.query(
        `
          UPDATE event_outbox
          SET status = 'processed', processed_at = NOW(), error_message = NULL
          WHERE id = $1
        `,
        [row.id]
      );

      await client.query('COMMIT');
      runtimeStats.consumedEvents += 1;
      runtimeStats.processedEvents += 1;
      runtimeStats.lastConsumedAt = new Date().toISOString();
      runtimeStats.lastSuccessAt = runtimeStats.lastConsumedAt;
    } catch (error) {
      const nextRetryCount = Number(row.retry_count || 0) + 1;
      if (nextRetryCount >= maxRetryCount) {
        await markDeadLetter(client, row, error.message || 'Failed to persist broker event', 'brokered');
      } else {
        await client.query(
          `
            UPDATE event_outbox
            SET
              status = 'failed',
              retry_count = retry_count + 1,
              error_message = LEFT($2, 500)
            WHERE id = $1
          `,
          [row.id, error.message || 'Failed to persist broker event']
        );
      }

      await client.query('COMMIT');
      runtimeStats.brokerConsumeFailures += 1;
      runtimeStats.failedEvents += 1;
      throw error;
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const server = http.createServer(async (req, res) => {
  const context = attachContext(req, res, 'event-processor-service');
  const startedAt = process.hrtime.bigint();
  const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('http_request_completed', {
      requestId: context.requestId,
      method: req.method || 'GET',
      path: requestUrl.pathname,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      clientIp: req.socket?.remoteAddress || null,
    });
  });

  if (requestUrl.pathname === '/health') {
    trackNodeRequest(metrics, req, res, '/health');
    return sendJson(res, 200, {
      status: 'healthy',
      service: 'event-processor-service',
      timestamp: new Date().toISOString(),
      runtime: runtimeStats,
    });
  }

  if (requestUrl.pathname === '/processor/stats') {
    trackNodeRequest(metrics, req, res, '/processor/stats');
    try {
      const queue = await getQueueStats();
      return sendJson(res, 200, {
        service: 'event-processor-service',
        runtime: runtimeStats,
        queue,
        config: { batchSize, pollIntervalMs, maxRetryCount, brokerEnabled: broker.enabled, brokerTopic },
      });
    } catch (error) {
      return sendJson(res, 500, { error: 'Failed to load processor stats' });
    }
  }

  // DLQ replay — re-queue dead-lettered events back to pending
  if (requestUrl.pathname === '/processor/dlq/replay' && req.method === 'POST') {
    trackNodeRequest(metrics, req, res, '/processor/dlq/replay');
    try {
      const limitParam = Number(requestUrl.searchParams?.get('limit') || 50);
      const limit = Math.min(limitParam, 200);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Find dead-lettered outbox entries
        const dlqResult = await client.query(
          `SELECT outbox_id FROM event_dead_letter
           WHERE outbox_id IS NOT NULL
           ORDER BY created_at ASC
           LIMIT $1`,
          [limit]
        );

        if (dlqResult.rows.length === 0) {
          await client.query('COMMIT');
          return sendJson(res, 200, { replayed: 0, message: 'No dead-lettered events to replay' });
        }

        const ids = dlqResult.rows.map((r) => r.outbox_id);
        await client.query(
          `UPDATE event_outbox
           SET status = 'pending', retry_count = 0, error_message = NULL
           WHERE id = ANY($1::uuid[])`,
          [ids]
        );
        await client.query(
          `DELETE FROM event_dead_letter WHERE outbox_id = ANY($1::uuid[])`,
          [ids]
        );
        await client.query('COMMIT');

        logger.info('dlq_replayed', { count: ids.length });
        return sendJson(res, 200, { replayed: ids.length, message: `Re-queued ${ids.length} events` });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('dlq_replay_failed', { error: error.message });
      return sendJson(res, 500, { error: 'DLQ replay failed' });
    }
  }

  // DLQ list
  if (requestUrl.pathname === '/processor/dlq' && req.method === 'GET') {
    trackNodeRequest(metrics, req, res, '/processor/dlq');
    try {
      const result = await pool.query(
        `SELECT id, outbox_id, tenant_id, event_type, failure_reason, original_status, created_at
         FROM event_dead_letter
         ORDER BY created_at DESC
         LIMIT 100`
      );
      return sendJson(res, 200, { deadLettered: result.rows, total: result.rows.length });
    } catch (error) {
      return sendJson(res, 500, { error: 'Failed to list DLQ' });
    }
  }

  if (requestUrl.pathname === '/metrics') {
    trackNodeRequest(metrics, req, res, '/metrics');
    return sendJson(res, 200, metrics.snapshot());
  }

  if (requestUrl.pathname === '/metrics/prometheus') {
    trackNodeRequest(metrics, req, res, '/metrics/prometheus');
    const body = renderPrometheusMetrics(metrics.snapshot());
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  trackNodeRequest(metrics, req, res, 'unmatched');
  return sendJson(res, 404, { error: 'Route not found' });
});

logger.info('service_started', {
  port,
  batchSize,
  pollIntervalMs,
  maxRetryCount,
  brokerEnabled,
  brokerTopic,
});
server.listen(port, () => {
  logger.info('admin_api_listening', { port });
});
if (broker.enabled) {
  broker.startConsumer(async (message) => {
    try {
      await consumeBrokerMessage(message);
    } catch (error) {
      runtimeStats.lastErrorAt = new Date().toISOString();
      logger.error('broker_consume_failed', {
        topic: message.topic,
        offset: message.offset,
        error: serializeError(error),
      });
    }
  }).catch((error) => {
    runtimeStats.lastErrorAt = new Date().toISOString();
    logger.error('broker_consumer_start_failed', {
      error: serializeError(error),
    });
  });
} else {
  logger.warn('broker_disabled', {
    requested: brokerEnabled,
    reason: broker.reason,
  });
}
runLoop();

process.on('SIGTERM', async () => {
  logger.info('service_stopping', { signal: 'SIGTERM' });
  server.close();
  await broker.disconnect();
  await pool.end();
  process.exit(0);
});

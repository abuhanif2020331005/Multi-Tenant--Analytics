require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const Joi = require('joi');
const { Pool } = require('pg');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { createSecurityHeadersMiddleware, createInjectionScanMiddleware } = require('../../../shared/middleware/security');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const { createTracer } = require('../../../shared/observability/tracer');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
} = require('../../../shared/observability/http');

validateEnv('event-ingestion-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'INGESTION_MODE',
]);

const app = express();
const PORT = Number(process.env.PORT || 8004);
const pool = createPgPool(Pool, 'event-ingestion-service');
const ingestionMode = process.env.INGESTION_MODE || 'direct';
const brokerEnabled = String(process.env.BROKER_ENABLED || 'false').toLowerCase() === 'true';
const metrics = createMetricsStore('event-ingestion-service');
const logger = createLogger('event-ingestion-service');
const tracer = createTracer('event-ingestion-service');

const singleEventSchema = Joi.object({
  userId: Joi.string().trim().allow(null, '').optional(),
  eventType: Joi.string().trim().min(1).max(100).required(),
  eventData: Joi.object().default({}),
  occurredAt: Joi.date().iso().optional(),
});

const ingestSchema = Joi.object({
  events: Joi.array().items(singleEventSchema).min(1).max(100).required(),
  source: Joi.string().trim().max(100).default('storefront'),
});

async function resolveTenantByApiKey(apiKey) {
  const result = await pool.query(
    `SELECT id, slug, name, status
     FROM tenants
     WHERE api_key = $1`,
    [apiKey]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

async function persistEventsDirect(client, tenant, events, req, source) {
  const insertedEventIds = [];

  for (const event of events) {
    const result = await client.query(
      `INSERT INTO events (
         tenant_id,
         user_id,
         event_type,
         event_data,
         ip_address,
         user_agent,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
       RETURNING id`,
      [
        tenant.id,
        event.userId || null,
        event.eventType,
        JSON.stringify({
          ...event.eventData,
          ingestionSource: source,
        }),
        req.ip,
        req.headers['user-agent'] || null,
        event.occurredAt || null,
      ]
    );

    insertedEventIds.push(result.rows[0].id);
  }

  return insertedEventIds;
}

async function enqueueEvents(client, tenant, events, req, source) {
  const outboxIds = [];

  for (const event of events) {
    const result = await client.query(
      `INSERT INTO event_outbox (
         tenant_id,
         user_id,
         event_type,
         event_payload,
         ip_address,
         user_agent,
         occurred_at,
         source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        tenant.id,
        event.userId || null,
        event.eventType,
        JSON.stringify({
          ...event.eventData,
          ingestionSource: source,
        }),
        req.ip,
        req.headers['user-agent'] || null,
        event.occurredAt || null,
        source,
      ]
    );

    outboxIds.push(result.rows[0].id);
  }

  return outboxIds;
}

async function tenantApiKeyAuth(req, res, next) {
  try {
    const apiKey = req.headers['x-tenant-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(401).json({ error: 'Missing x-tenant-api-key header' });
    }

    const tenant = await resolveTenantByApiKey(apiKey);
    if (!tenant) {
      return res.status(401).json({ error: 'Invalid tenant API key' });
    }

    if (tenant.status !== 'active') {
      return res.status(403).json({ error: 'Tenant is not active' });
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createRequestContextMiddleware('event-ingestion-service', logger));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'event-ingestion-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

// Backpressure monitoring — queue depth and processing lag
app.get('/ingest/backpressure', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'publish_failed') AS publish_failed,
        COUNT(*) FILTER (WHERE status = 'brokered') AS brokered,
        COUNT(*) FILTER (WHERE status = 'processed') AS processed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FILTER (WHERE status = 'pending') AS oldest_pending_age_sec
      FROM event_outbox
    `);

    const row = result.rows[0];
    const pending = Number(row.pending || 0);
    const oldestAge = Number(row.oldest_pending_age_sec || 0);
    const pressure = pending > 1000 ? 'high' : pending > 100 ? 'medium' : 'low';

    res.json({
      pressure,
      pending,
      publishFailed: Number(row.publish_failed || 0),
      brokered: Number(row.brokered || 0),
      processed: Number(row.processed || 0),
      failed: Number(row.failed || 0),
      oldestPendingAgeSec: oldestAge,
      recommendation: pending > 1000 ? 'Scale event-processor replicas' : 'Normal',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check backpressure' });
  }
});

app.post('/ingest/events', tenantApiKeyAuth, async (req, res) => {
  try {
    const { error, value } = ingestSchema.validate(req.body, {
      abortEarly: false,
      convert: true,
    });

    if (error) {
      return res.status(400).json({
        error: 'Invalid request payload',
        details: error.details.map((detail) => detail.message),
      });
    }

    const { events, source } = value;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const acceptedIds =
        ingestionMode === 'outbox'
          ? await enqueueEvents(client, req.tenant, events, req, source)
          : await persistEventsDirect(client, req.tenant, events, req, source);

      await client.query('COMMIT');

      res.status(202).json({
        message:
          ingestionMode === 'outbox'
            ? 'Events accepted and queued for async processing'
            : ingestionMode === 'broker'
              ? 'Events accepted and queued for broker-backed processing'
              : 'Events accepted for processing',
        mode: ingestionMode,
        broker: {
          enabled: brokerEnabled,
        },
        tenant: {
          id: req.tenant.id,
          slug: req.tenant.slug,
          name: req.tenant.name,
        },
        accepted: acceptedIds.length,
        eventIds: acceptedIds,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Ingest events error:', error);
    res.status(500).json({ error: 'Failed to ingest events' });
  }
});

app.get('/ingest/openapi', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Event Ingestion Service API',
      version: '1.0.0',
      description: 'Tenant-facing event ingestion API with direct or outbox-backed processing',
    },
    paths: {
      '/ingest/events': {
        post: {
          summary: 'Ingest one or more tenant events',
          parameters: [
            {
              in: 'header',
              name: 'x-tenant-api-key',
              required: true,
              schema: { type: 'string' },
            },
          ],
        },
      },
    },
  });
});

app.use((err, req, res, next) => {
  logger.error('request_failed', {
    requestId: req.context?.requestId || null,
    path: req.originalUrl,
    method: req.method,
    error: serializeError(err),
  });
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  logger.info('service_started', { port: Number(PORT), ingestionMode, brokerEnabled });
});

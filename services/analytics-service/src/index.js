require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const Joi = require('joi');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { authenticateRequest } = require('../../../shared/middleware/auth');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const { createTracer } = require('../../../shared/observability/tracer');
const { createTracingMiddleware } = require('../../../shared/observability/http');
const { createSecurityHeadersMiddleware, createInjectionScanMiddleware } = require('../../../shared/middleware/security');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
} = require('../../../shared/observability/http');

validateEnv('analytics-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
]);

const app = express();
const PORT = process.env.PORT || 8003;
const pool = createPgPool(Pool, 'analytics-service');
const authMiddleware = authenticateRequest(jwt);
const metrics = createMetricsStore('analytics-service');
const logger = createLogger('analytics-service');
const tracer = createTracer('analytics-service');

const createEventSchema = Joi.object({
  userId: Joi.string().required(),
  eventType: Joi.string().required(),
  eventData: Joi.object().default({}),
});

const listEventsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
  eventType: Joi.string().trim().optional(),
  userId: Joi.string().trim().optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
});

function buildEventFilters({ tenantId, eventType, userId, startDate, endDate }) {
  const clauses = ['tenant_id = $1'];
  const params = [tenantId];

  if (eventType) {
    params.push(eventType);
    clauses.push(`event_type = $${params.length}`);
  }

  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }

  if (startDate) {
    params.push(startDate);
    clauses.push(`created_at >= $${params.length}`);
  }

  if (endDate) {
    params.push(endDate);
    clauses.push(`created_at <= $${params.length}`);
  }

  return {
    whereClause: clauses.join(' AND '),
    params,
  };
}

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(createRequestContextMiddleware('analytics-service', logger));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createTracingMiddleware(tracer));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'analytics-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

app.post('/events', authMiddleware, async (req, res) => {
  try {
    const { error, value } = createEventSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { userId, eventType, eventData } = value;
    const result = await pool.query(
      `INSERT INTO events (tenant_id, user_id, event_type, event_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        req.user.tenantId,
        userId,
        eventType,
        JSON.stringify(eventData),
        req.ip,
        req.headers['user-agent'],
      ]
    );

    res.status(201).json({
      id: result.rows[0].id,
      message: 'Event created successfully',
      createdAt: result.rows[0].created_at,
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.get('/events', authMiddleware, async (req, res) => {
  try {
    const { error, value } = listEventsQuerySchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { limit, offset, eventType, userId, startDate, endDate } = value;
    const { whereClause, params } = buildEventFilters({
      tenantId: req.user.tenantId,
      eventType,
      userId,
      startDate,
      endDate,
    });

    const eventsQuery = `
      SELECT id, tenant_id, user_id, event_type, event_data, ip_address, created_at
      FROM events
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countQuery = `SELECT COUNT(*) FROM events WHERE ${whereClause}`;
    const listParams = [...params, limit, offset];

    const [result, countResult] = await Promise.all([
      pool.query(eventsQuery, listParams),
      pool.query(countQuery, params),
    ]);

    res.json({
      events: result.rows,
      total: Number(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error) {
    console.error('List events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/events/stats', authMiddleware, async (req, res) => {
  try {
    const statsQuerySchema = listEventsQuerySchema
      .fork(['limit', 'offset', 'eventType', 'userId'], (schema) => schema.forbidden());
    const { error, value } = statsQuerySchema.validate(req.query, { convert: true });

    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { startDate, endDate } = value;
    const { whereClause, params } = buildEventFilters({
      tenantId: req.user.tenantId,
      startDate,
      endDate,
    });

    const result = await pool.query(
      `
        SELECT
          event_type,
          COUNT(*) AS count,
          DATE_TRUNC('day', created_at) AS date
        FROM events
        WHERE ${whereClause}
        GROUP BY event_type, DATE_TRUNC('day', created_at)
        ORDER BY date DESC
      `,
      params
    );

    res.json({ stats: result.rows });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/events/summary', authMiddleware, async (req, res) => {
  try {
    const summaryQuerySchema = Joi.object({
      days: Joi.number().integer().min(1).max(365).default(30),
    });
    const { error, value } = summaryQuerySchema.validate(req.query, { convert: true });

    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { days } = value;
    const result = await pool.query(
      `
        SELECT
          COUNT(*) AS total_events,
          COUNT(DISTINCT NULLIF(user_id, '')) AS unique_users,
          COUNT(*) FILTER (WHERE event_type = 'product_view') AS product_views,
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart') AS add_to_cart,
          COUNT(*) FILTER (WHERE event_type = 'purchase') AS purchases
        FROM events
        WHERE tenant_id = $1
          AND created_at >= NOW() - ($2::text || ' days')::interval
      `,
      [req.user.tenantId, String(days)]
    );

    const row = result.rows[0];
    const productViews = Number(row.product_views || 0);
    const addToCart = Number(row.add_to_cart || 0);
    const purchases = Number(row.purchases || 0);

    res.json({
      windowDays: days,
      totalEvents: Number(row.total_events || 0),
      uniqueUsers: Number(row.unique_users || 0),
      productViews,
      addToCart,
      purchases,
      cartRate: productViews > 0 ? Number(((addToCart / productViews) * 100).toFixed(2)) : 0,
      conversionRate: productViews > 0 ? Number(((purchases / productViews) * 100).toFixed(2)) : 0,
    });
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: 'Failed to fetch event summary' });
  }
});

// Conversion funnel — view → cart → purchase drop-off per product
app.get('/events/funnel', authMiddleware, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days || 30), 365);
    const result = await pool.query(
      `
        SELECT
          event_data->>'productId'                                           AS product_id,
          COUNT(*) FILTER (WHERE event_type = 'product_view')                AS views,
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart')                 AS add_to_cart,
          COUNT(*) FILTER (WHERE event_type = 'purchase')                    AS purchases,
          COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'product_view') AS unique_viewers
        FROM events
        WHERE tenant_id = $1
          AND created_at >= NOW() - ($2::text || ' days')::interval
          AND event_data ? 'productId'
        GROUP BY event_data->>'productId'
        HAVING COUNT(*) FILTER (WHERE event_type = 'product_view') > 0
        ORDER BY views DESC
        LIMIT 50
      `,
      [req.user.tenantId, String(days)]
    );

    res.json({
      funnel: result.rows.map((row) => {
        const views = Number(row.views);
        const cart = Number(row.add_to_cart);
        const purchases = Number(row.purchases);
        return {
          productId: row.product_id,
          views,
          addToCart: cart,
          purchases,
          uniqueViewers: Number(row.unique_viewers),
          viewToCartRate: views > 0 ? Number(((cart / views) * 100).toFixed(2)) : 0,
          cartToPurchaseRate: cart > 0 ? Number(((purchases / cart) * 100).toFixed(2)) : 0,
          overallConversionRate: views > 0 ? Number(((purchases / views) * 100).toFixed(2)) : 0,
        };
      }),
      windowDays: days,
    });
  } catch (error) {
    logger.error('funnel_error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch funnel data' });
  }
});

// Top products by engagement score
app.get('/events/top-products', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);
    const days = Math.min(Number(req.query.days || 30), 365);

    const result = await pool.query(
      `
        SELECT
          event_data->>'productId'                                           AS product_id,
          COUNT(*) FILTER (WHERE event_type = 'product_view')                AS views,
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart')                 AS add_to_cart,
          COUNT(*) FILTER (WHERE event_type = 'purchase')                    AS purchases,
          COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'product_view') AS unique_viewers,
          (
            COUNT(*) FILTER (WHERE event_type = 'product_view') * 1 +
            COUNT(*) FILTER (WHERE event_type = 'add_to_cart')  * 3 +
            COUNT(*) FILTER (WHERE event_type = 'purchase')     * 5
          ) AS engagement_score
        FROM events
        WHERE tenant_id = $1
          AND created_at >= NOW() - ($2::text || ' days')::interval
          AND event_data ? 'productId'
        GROUP BY event_data->>'productId'
        ORDER BY engagement_score DESC
        LIMIT $3
      `,
      [req.user.tenantId, String(days), limit]
    );

    res.json({
      products: result.rows.map((row) => ({
        productId: row.product_id,
        views: Number(row.views),
        addToCart: Number(row.add_to_cart),
        purchases: Number(row.purchases),
        uniqueViewers: Number(row.unique_viewers),
        engagementScore: Number(row.engagement_score),
      })),
      windowDays: days,
    });
  } catch (error) {
    logger.error('top_products_error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// Hourly event volume — real-time dashboard feed
app.get('/events/hourly', authMiddleware, async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours || 24), 168);
    const result = await pool.query(
      `
        SELECT
          DATE_TRUNC('hour', created_at) AS hour,
          event_type,
          COUNT(*)                       AS count
        FROM events
        WHERE tenant_id = $1
          AND created_at >= NOW() - ($2::text || ' hours')::interval
        GROUP BY DATE_TRUNC('hour', created_at), event_type
        ORDER BY hour DESC
      `,
      [req.user.tenantId, String(hours)]
    );

    res.json({ hourly: result.rows, lookbackHours: hours });
  } catch (error) {
    logger.error('hourly_error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch hourly data' });
  }
});

// Per-tenant usage/billing metrics
app.get('/events/usage', authMiddleware, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days || 30), 365);
    const [totalsResult, dailyResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)                                                    AS total_events,
           COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS unique_users,
           COUNT(*) FILTER (WHERE event_type = 'product_view')        AS product_views,
           COUNT(*) FILTER (WHERE event_type = 'add_to_cart')         AS add_to_cart,
           COUNT(*) FILTER (WHERE event_type = 'purchase')            AS purchases,
           COUNT(DISTINCT event_type)                                  AS distinct_event_types,
           MIN(created_at)                                             AS first_event_at,
           MAX(created_at)                                             AS last_event_at,
           COUNT(*) * 512                                              AS estimated_storage_bytes
         FROM events
         WHERE tenant_id = $1
           AND created_at >= NOW() - ($2::text || ' days')::interval`,
        [req.user.tenantId, String(days)]
      ),
      pool.query(
        `SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS events
         FROM events
         WHERE tenant_id = $1
           AND created_at >= NOW() - ($2::text || ' days')::interval
         GROUP BY DATE_TRUNC('day', created_at)
         ORDER BY day DESC`,
        [req.user.tenantId, String(days)]
      ),
    ]);

    const row = totalsResult.rows[0];
    res.json({
      tenantId: req.user.tenantId,
      windowDays: days,
      totals: {
        events: Number(row.total_events || 0),
        uniqueUsers: Number(row.unique_users || 0),
        productViews: Number(row.product_views || 0),
        addToCart: Number(row.add_to_cart || 0),
        purchases: Number(row.purchases || 0),
        distinctEventTypes: Number(row.distinct_event_types || 0),
        estimatedStorageBytes: Number(row.estimated_storage_bytes || 0),
      },
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
      dailyBreakdown: dailyResult.rows.map((r) => ({ day: r.day, events: Number(r.events) })),
    });
  } catch (error) {
    logger.error('usage_error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch usage metrics' });
  }
});

app.use((err, req, res, next) => {
  logger.error('request_failed', {
    requestId: req.context?.requestId || null,
    path: req.originalUrl,
    method: req.method,
    error: serializeError(err),
  });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('service_started', { port: Number(PORT) });
});

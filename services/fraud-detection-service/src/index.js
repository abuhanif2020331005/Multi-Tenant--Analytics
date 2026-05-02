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
const { dispatchWebhook } = require('./webhook');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
} = require('../../../shared/observability/http');

validateEnv('fraud-detection-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
]);

const app = express();
const PORT = Number(process.env.PORT || 8006);
const pool = createPgPool(Pool, 'fraud-detection-service');
const authMiddleware = authenticateRequest(jwt);
const metrics = createMetricsStore('fraud-detection-service');
const logger = createLogger('fraud-detection-service');
const tracer = createTracer('fraud-detection-service');

const analysisSchema = Joi.object({
  userId: Joi.string().trim().required(),
  windowMinutes: Joi.number().integer().min(5).max(1440).default(60),
  purchaseAmountThreshold: Joi.number().min(0).default(500),
  velocityThreshold: Joi.number().integer().min(1).max(100).default(3),
  sharedIpThreshold: Joi.number().integer().min(1).max(100).default(3),
});

const alertsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  hours: Joi.number().integer().min(1).max(168).default(24),
  minRiskScore: Joi.number().min(1).max(100).default(40),
});

function toNumber(value) {
  return Number(value || 0);
}

function buildIndicators(metrics, thresholds) {
  const indicators = [];

  if (metrics.purchaseCount >= thresholds.velocityThreshold) {
    indicators.push({
      code: 'HIGH_PURCHASE_VELOCITY',
      severity: 'high',
      message: `User has ${metrics.purchaseCount} purchase events in the last ${thresholds.windowMinutes} minutes.`,
    });
  }

  if (metrics.highValuePurchaseCount > 0) {
    indicators.push({
      code: 'HIGH_VALUE_PURCHASES',
      severity: metrics.highValuePurchaseCount >= 2 ? 'high' : 'medium',
      message: `${metrics.highValuePurchaseCount} purchase events exceeded amount ${thresholds.purchaseAmountThreshold}.`,
    });
  }

  if (metrics.distinctUsersOnIp >= thresholds.sharedIpThreshold) {
    indicators.push({
      code: 'SHARED_IP_ACTIVITY',
      severity: 'medium',
      message: `${metrics.distinctUsersOnIp} users purchased from the same IP in the active window.`,
    });
  }

  return indicators;
}

function calculateRiskScore(metrics, thresholds) {
  let score = 0;

  if (metrics.purchaseCount >= thresholds.velocityThreshold) {
    score += 45;
  } else {
    score += Math.min(metrics.purchaseCount * 10, 30);
  }

  score += Math.min(metrics.highValuePurchaseCount * 20, 40);

  if (metrics.distinctUsersOnIp >= thresholds.sharedIpThreshold) {
    score += 20;
  } else {
    score += Math.min(metrics.distinctUsersOnIp * 5, 15);
  }

  return Math.min(score, 100);
}

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(createRequestContextMiddleware('fraud-detection-service', logger));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createTracingMiddleware(tracer));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'fraud-detection-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

app.get('/fraud/analyze', authMiddleware, async (req, res) => {
  try {
    const { error, value } = analysisSchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const {
      userId,
      windowMinutes,
      purchaseAmountThreshold,
      velocityThreshold,
      sharedIpThreshold,
    } = value;

    const metricsResult = await pool.query(
      `
        WITH recent_purchases AS (
          SELECT
            user_id,
            ip_address,
            event_data,
            created_at
          FROM events
          WHERE tenant_id = $1
            AND event_type = 'purchase'
            AND created_at >= NOW() - ($2::text || ' minutes')::interval
        ),
        target_user_purchases AS (
          SELECT *
          FROM recent_purchases
          WHERE user_id = $3
        ),
        target_user_ips AS (
          SELECT DISTINCT ip_address
          FROM target_user_purchases
          WHERE ip_address IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*) FROM target_user_purchases) AS purchase_count,
          (
            SELECT COUNT(*)
            FROM target_user_purchases
            WHERE COALESCE(NULLIF(event_data->>'amount', ''), '0')::numeric >= $4
          ) AS high_value_purchase_count,
          (
            SELECT COUNT(DISTINCT rp.user_id)
            FROM recent_purchases rp
            JOIN target_user_ips tui ON tui.ip_address = rp.ip_address
            WHERE rp.user_id IS NOT NULL
          ) AS distinct_users_on_ip
      `,
      [req.user.tenantId, String(windowMinutes), userId, purchaseAmountThreshold]
    );

    const row = metricsResult.rows[0];
    const metrics = {
      purchaseCount: toNumber(row.purchase_count),
      highValuePurchaseCount: toNumber(row.high_value_purchase_count),
      distinctUsersOnIp: toNumber(row.distinct_users_on_ip),
    };

    const thresholds = {
      windowMinutes,
      purchaseAmountThreshold,
      velocityThreshold,
      sharedIpThreshold,
    };

    const indicators = buildIndicators(metrics, thresholds);
    const riskScore = calculateRiskScore(metrics, thresholds);
    const riskLevel = riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low';

    const responsePayload = {
      userId,
      tenantId: req.user.tenantId,
      riskScore,
      riskLevel,
      indicators,
      metrics,
      thresholds,
    };

    res.json(responsePayload);

    // Fire-and-forget webhook for high/medium risk — don't block the response
    if (riskScore >= 40) {
      const webhookUrl = process.env.FRAUD_WEBHOOK_URL || null;
      dispatchWebhook(webhookUrl, { event: 'fraud.alert', ...responsePayload }, logger).catch(() => {});
    }
  } catch (error) {
    console.error('Fraud analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze fraud signals' });
  }
});

app.get('/fraud/alerts', authMiddleware, async (req, res) => {
  try {
    const { error, value } = alertsQuerySchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { limit, hours, minRiskScore } = value;
    const result = await pool.query(
      `
        WITH recent_purchases AS (
          SELECT
            user_id,
            ip_address,
            event_data,
            created_at
          FROM events
          WHERE tenant_id = $1
            AND event_type = 'purchase'
            AND created_at >= NOW() - ($2::text || ' hours')::interval
            AND user_id IS NOT NULL
        ),
        grouped AS (
          SELECT
            user_id,
            COUNT(*) AS purchase_count,
            COUNT(*) FILTER (
              WHERE COALESCE(NULLIF(event_data->>'amount', ''), '0')::numeric >= 500
            ) AS high_value_purchase_count,
            MAX(created_at) AS latest_purchase_at,
            COUNT(DISTINCT ip_address) AS distinct_ip_count
          FROM recent_purchases
          GROUP BY user_id
        )
        SELECT
          user_id,
          purchase_count,
          high_value_purchase_count,
          distinct_ip_count,
          latest_purchase_at,
          LEAST(
            100,
            purchase_count * 10 +
            high_value_purchase_count * 20 +
            distinct_ip_count * 5
          ) AS risk_score
        FROM grouped
        WHERE LEAST(
          100,
          purchase_count * 10 +
          high_value_purchase_count * 20 +
          distinct_ip_count * 5
        ) >= $3
        ORDER BY risk_score DESC, latest_purchase_at DESC
        LIMIT $4
      `,
      [req.user.tenantId, String(hours), minRiskScore, limit]
    );

    res.json({
      alerts: result.rows.map((row) => ({
        userId: row.user_id,
        riskScore: toNumber(row.risk_score),
        purchaseCount: toNumber(row.purchase_count),
        highValuePurchaseCount: toNumber(row.high_value_purchase_count),
        distinctIpCount: toNumber(row.distinct_ip_count),
        latestPurchaseAt: row.latest_purchase_at,
      })),
      lookbackHours: hours,
      minRiskScore,
    });
  } catch (error) {
    console.error('Fraud alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch fraud alerts' });
  }
});

app.get('/fraud/openapi', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Fraud Detection Service API',
      version: '1.0.0',
      description: 'Heuristic fraud detection endpoints for tenant purchase activity',
    },
    paths: {
      '/fraud/analyze': {
        get: {
          summary: 'Analyze fraud signals for a specific user',
        },
      },
      '/fraud/alerts': {
        get: {
          summary: 'List recent high-risk fraud alerts for a tenant',
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
  logger.info('service_started', { port: Number(PORT) });
});


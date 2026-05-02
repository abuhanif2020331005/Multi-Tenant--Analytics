require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const Joi = require('joi');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const {
  buildDeterministicVector,
  buildSemanticDocument,
  scoreSemanticMatch,
  tokenize,
} = require('../../../shared/ai/semantic');
const { createQdrantClient } = require('../../../shared/ai/qdrant');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { authenticateRequest } = require('../../../shared/middleware/auth');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const { createTracer } = require('../../../shared/observability/tracer');
const { createTracingMiddleware } = require('../../../shared/observability/http');
const { createSecurityHeadersMiddleware, createInjectionScanMiddleware } = require('../../../shared/middleware/security');
const { createOptionalRedisClient } = require('../../../shared/cache/redis');
const { createRecommendationCache } = require('../../../shared/cache/recommendation-cache');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
} = require('../../../shared/observability/http');

validateEnv('recommendation-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
]);

const app = express();
const PORT = Number(process.env.PORT || 8005);
const pool = createPgPool(Pool, 'recommendation-service');
const authMiddleware = authenticateRequest(jwt);
const metrics = createMetricsStore('recommendation-service');
const logger = createLogger('recommendation-service');
const tracer = createTracer('recommendation-service');
const qdrant = createQdrantClient({ logger });
const redisClient = createOptionalRedisClient({ logger });
const cache = createRecommendationCache(redisClient, logger);
const CACHE_TTL = Number(process.env.RECOMMENDATION_CACHE_TTL_SECONDS || 120);

const recommendationQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(10),
  days: Joi.number().integer().min(1).max(365).default(30),
  userId: Joi.string().trim().optional(),
});

const similarProductsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(5),
  days: Joi.number().integer().min(1).max(365).default(60),
});

const semanticRecommendationSchema = Joi.object({
  q: Joi.string().trim().min(2).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

function normalizeProductRecord(row) {
  return {
    productId: row.product_id,
    name: row.name || row.product_id,
    category: row.category || null,
    price: row.price !== undefined && row.price !== null ? Number(row.price) : null,
    score: Number(row.score),
    views: Number(row.views || 0),
    addToCart: Number(row.add_to_cart || 0),
    purchases: Number(row.purchases || 0),
  };
}

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(createRequestContextMiddleware('recommendation-service', logger));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createTracingMiddleware(tracer));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'recommendation-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

app.get('/recommendations/popular', authMiddleware, async (req, res) => {
  try {
    const { error, value } = recommendationQuerySchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { limit, days } = value;
    const cacheKey = cache.tenantKey(req.user.tenantId, 'popular', `${limit}:${days}`);

    const data = await cache.get(cacheKey, CACHE_TTL, async () => {
      const result = await pool.query(
        `
          SELECT
            p.product_id,
            p.name,
            p.category,
            p.price,
            COUNT(*) FILTER (WHERE event_type = 'product_view') AS views,
            COUNT(*) FILTER (WHERE event_type = 'add_to_cart') AS add_to_cart,
            COUNT(*) FILTER (WHERE event_type = 'purchase') AS purchases,
            (
              COUNT(*) FILTER (WHERE event_type = 'product_view') * 1 +
              COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 3 +
              COUNT(*) FILTER (WHERE event_type = 'purchase') * 5
            ) AS score
          FROM events e
          LEFT JOIN products p
            ON p.tenant_id = e.tenant_id
           AND p.product_id = e.event_data->>'productId'
          WHERE e.tenant_id = $1
            AND e.created_at >= NOW() - ($2::text || ' days')::interval
            AND e.event_data ? 'productId'
          GROUP BY p.product_id, p.name, p.category, p.price, e.event_data->>'productId'
          ORDER BY score DESC, purchases DESC, add_to_cart DESC, views DESC
          LIMIT $3
        `,
        [req.user.tenantId, String(days), limit]
      );
      return {
        recommendations: result.rows.map(normalizeProductRecord),
        strategy: 'tenant-popularity',
        windowDays: days,
      };
    });

    res.json(data);
  } catch (error) {
    console.error('Popular recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

app.get('/recommendations/for-user', authMiddleware, async (req, res) => {
  try {
    const { error, value } = recommendationQuerySchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const requestedUserId = value.userId || req.user.userId;
    if (!requestedUserId) {
      return res.status(400).json({ error: 'userId is required when the token does not include one' });
    }

    const { limit, days } = value;
    const result = await pool.query(
      `
        WITH user_seen_products AS (
          SELECT DISTINCT event_data->>'productId' AS product_id
          FROM events
          WHERE tenant_id = $1
            AND user_id = $2
            AND created_at >= NOW() - ($3::text || ' days')::interval
            AND event_data ? 'productId'
        )
        SELECT
          p.product_id,
          p.name,
          p.category,
          p.description,
          p.price,
          p.metadata,
          COUNT(*) FILTER (WHERE event_type = 'product_view') AS views,
          COUNT(*) FILTER (WHERE event_type = 'add_to_cart') AS add_to_cart,
          COUNT(*) FILTER (WHERE event_type = 'purchase') AS purchases,
          (
            COUNT(*) FILTER (WHERE event_type = 'product_view') * 1 +
            COUNT(*) FILTER (WHERE event_type = 'add_to_cart') * 3 +
            COUNT(*) FILTER (WHERE event_type = 'purchase') * 5
          ) AS score
        FROM events e
        LEFT JOIN products p
          ON p.tenant_id = e.tenant_id
         AND p.product_id = e.event_data->>'productId'
        WHERE e.tenant_id = $1
          AND e.created_at >= NOW() - ($3::text || ' days')::interval
          AND e.event_data ? 'productId'
          AND e.event_data->>'productId' NOT IN (
            SELECT product_id FROM user_seen_products WHERE product_id IS NOT NULL
          )
        GROUP BY p.product_id, p.name, p.category, p.price, e.event_data->>'productId'
        ORDER BY score DESC, purchases DESC, add_to_cart DESC, views DESC
        LIMIT $4
      `,
      [req.user.tenantId, requestedUserId, String(days), limit]
    );

    res.json({
      recommendations: result.rows.map(normalizeProductRecord),
      strategy: 'popular-excluding-seen',
      userId: requestedUserId,
      windowDays: days,
    });
  } catch (error) {
    console.error('User recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

app.get('/recommendations/similar/:productId', authMiddleware, async (req, res) => {
  try {
    const { error, value } = similarProductsQuerySchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const sourceProductResult = await pool.query(
      `
        SELECT product_id, name, category, metadata
        FROM products
        WHERE tenant_id = $1 AND product_id = $2 AND is_active = true
      `,
      [req.user.tenantId, req.params.productId]
    );

    if (sourceProductResult.rows.length === 0) {
      return res.status(404).json({ error: 'Source product not found' });
    }

    const sourceProduct = sourceProductResult.rows[0];
    const { limit, days } = value;
    const result = await pool.query(
      `
        WITH source_sessions AS (
          SELECT DISTINCT user_id
          FROM events
          WHERE tenant_id = $1
            AND event_data->>'productId' = $2
            AND user_id IS NOT NULL
            AND created_at >= NOW() - ($3::text || ' days')::interval
        )
        SELECT
          p.product_id,
          p.name,
          p.category,
          p.price,
          COUNT(*) FILTER (WHERE e.event_type = 'product_view') AS views,
          COUNT(*) FILTER (WHERE e.event_type = 'add_to_cart') AS add_to_cart,
          COUNT(*) FILTER (WHERE e.event_type = 'purchase') AS purchases,
          (
            COUNT(*) FILTER (WHERE e.event_type = 'product_view') * 1 +
            COUNT(*) FILTER (WHERE e.event_type = 'add_to_cart') * 3 +
            COUNT(*) FILTER (WHERE e.event_type = 'purchase') * 5 +
            CASE WHEN p.category = $4 THEN 5 ELSE 0 END
          ) AS score
        FROM events e
        JOIN source_sessions ss ON ss.user_id = e.user_id
        JOIN products p
          ON p.tenant_id = e.tenant_id
         AND p.product_id = e.event_data->>'productId'
        WHERE e.tenant_id = $1
          AND p.product_id <> $2
          AND e.created_at >= NOW() - ($3::text || ' days')::interval
        GROUP BY p.product_id, p.name, p.category, p.price
        ORDER BY score DESC, purchases DESC, add_to_cart DESC, views DESC
        LIMIT $5
      `,
      [req.user.tenantId, req.params.productId, String(days), sourceProduct.category || '', limit]
    );

    res.json({
      sourceProduct: {
        productId: sourceProduct.product_id,
        name: sourceProduct.name,
        category: sourceProduct.category,
      },
      recommendations: result.rows.map(normalizeProductRecord),
      strategy: 'co-view-and-category',
      windowDays: days,
    });
  } catch (error) {
    console.error('Similar recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch similar products' });
  }
});

app.get('/recommendations/semantic', authMiddleware, async (req, res) => {
  try {
    const { error, value } = semanticRecommendationSchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    if (qdrant.enabled) {
      const vector = buildDeterministicVector(tokenize(value.q));
      const vectorResults = await qdrant.search(vector, value.limit, {
        must: [
          {
            key: 'tenantId',
            match: {
              value: req.user.tenantId,
            },
          },
        ],
      });

      if (vectorResults.length > 0) {
        return res.json({
          query: value.q,
          strategy: 'qdrant-vector-search',
          recommendations: vectorResults.map((item) => ({
            productId: item.payload?.productId,
            name: item.payload?.name,
            category: item.payload?.category || null,
            score: Number(item.score || 0),
            embeddingVersion: item.payload?.embeddingVersion || 'local-keyword-v1',
          })),
        });
      }
    }

    const result = await pool.query(
      `
        SELECT
          p.product_id,
          p.name,
          p.category,
          p.price,
          pe.document_text,
          pe.semantic_tokens,
          pe.embedding_version,
          COUNT(*) FILTER (WHERE e.event_type = 'product_view') AS views,
          COUNT(*) FILTER (WHERE e.event_type = 'add_to_cart') AS add_to_cart,
          COUNT(*) FILTER (WHERE e.event_type = 'purchase') AS purchases
        FROM products p
        LEFT JOIN product_embeddings pe
          ON pe.tenant_id = p.tenant_id
         AND pe.product_id = p.product_id
        LEFT JOIN events e
          ON e.tenant_id = p.tenant_id
         AND e.event_data->>'productId' = p.product_id
         AND e.created_at >= NOW() - ('60 days')::interval
        WHERE p.tenant_id = $1
          AND p.is_active = true
        GROUP BY p.product_id, p.name, p.category, p.description, p.price, p.metadata, pe.document_text, pe.semantic_tokens, pe.embedding_version
      `,
      [req.user.tenantId]
    );

    const ranked = result.rows
      .map((row) => {
        const fallbackSemantic = buildSemanticDocument({
          name: row.name,
          category: row.category,
          description: row.description,
          metadata: row.metadata,
        });
        const searchable = {
          ...row,
          document_text: row.document_text || fallbackSemantic.documentText,
          semantic_tokens: row.semantic_tokens || fallbackSemantic.tokens,
        };
        const semanticScore = scoreSemanticMatch(value.q, searchable);
        const engagementBoost =
          Number(row.views || 0) * 0.02 +
          Number(row.add_to_cart || 0) * 0.05 +
          Number(row.purchases || 0) * 0.08;

        return {
          ...searchable,
          score: Number((semanticScore + engagementBoost).toFixed(4)),
          semanticScore: Number(semanticScore.toFixed(4)),
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
      .slice(0, value.limit);

    res.json({
      query: value.q,
      strategy: 'semantic-query-plus-engagement',
      recommendations: ranked.map((row) => ({
        productId: row.product_id,
        name: row.name,
        category: row.category,
        price: row.price !== undefined && row.price !== null ? Number(row.price) : null,
        score: row.score,
        semanticScore: row.semanticScore,
        views: Number(row.views || 0),
        addToCart: Number(row.add_to_cart || 0),
        purchases: Number(row.purchases || 0),
        embeddingVersion: row.embedding_version || 'missing-index',
      })),
    });
  } catch (error) {
    console.error('Semantic recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch semantic recommendations' });
  }
});

app.get('/recommendations/openapi', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Recommendation Service API',
      version: '1.0.0',
      description: 'Recommendation endpoints based on tenant event history',
    },
    paths: {
      '/recommendations/popular': {
        get: {
          summary: 'Get top products for a tenant',
        },
      },
      '/recommendations/for-user': {
        get: {
          summary: 'Get simple recommendations for a user by excluding seen products',
        },
      },
      '/recommendations/similar/{productId}': {
        get: {
          summary: 'Get similar products for a specific catalog item',
        },
      },
      '/recommendations/semantic': {
        get: {
          summary: 'Get recommendations for a semantic-style natural-language query',
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
  logger.info('service_started', {
    port: Number(PORT),
    qdrantEnabled: qdrant.enabled,
    qdrantCollection: qdrant.collection,
    cacheEnabled: cache.enabled,
    cacheTtlSeconds: CACHE_TTL,
  });
  redisClient.connect().catch(() => {});
});

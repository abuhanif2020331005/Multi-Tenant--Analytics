require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const Joi = require('joi');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildSemanticDocument, scoreSemanticMatch } = require('../../../shared/ai/semantic');
const { createQdrantClient } = require('../../../shared/ai/qdrant');
const { createChatbotHandler } = require('./chatbot');
const { runProductUpsertSaga } = require('./product-saga');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { authenticateRequest, requireRoles } = require('../../../shared/middleware/auth');
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

validateEnv('catalog-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
]);

const app = express();
const PORT = Number(process.env.PORT || 8008);
const pool = createPgPool(Pool, 'catalog-service');
const authMiddleware = authenticateRequest(jwt);
const productWriteMiddleware = requireRoles(['admin', 'analyst']);
const metrics = createMetricsStore('catalog-service');
const logger = createLogger('catalog-service');
const tracer = createTracer('catalog-service');
const qdrant = createQdrantClient({ logger });
const chatbotHandler = createChatbotHandler(pool, logger);

const listProductsSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
  category: Joi.string().trim().optional(),
  q: Joi.string().trim().allow('').optional(),
});

const productMutationSchema = Joi.object({
  productId: Joi.string().trim().max(100).required(),
  name: Joi.string().trim().max(255).required(),
  category: Joi.string().trim().max(100).allow('', null).optional(),
  description: Joi.string().trim().allow('', null).optional(),
  price: Joi.number().min(0).default(0),
  currency: Joi.string().trim().uppercase().max(10).default('USD'),
  metadata: Joi.object().default({}),
  isActive: Joi.boolean().default(true),
});

const semanticSearchSchema = Joi.object({
  q: Joi.string().trim().min(2).required(),
  limit: Joi.number().integer().min(1).max(20).default(10),
  category: Joi.string().trim().optional(),
});

const reindexSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(1000).default(250),
});

async function upsertSemanticIndex(client, tenantId, product) {
  const semantic = buildSemanticDocument(product);
  await client.query(
    `
      INSERT INTO product_embeddings (
        tenant_id,
        product_id,
        document_text,
        semantic_tokens,
        feature_weights,
        embedding_version,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (tenant_id, product_id)
      DO UPDATE
      SET
        document_text = EXCLUDED.document_text,
        semantic_tokens = EXCLUDED.semantic_tokens,
        feature_weights = EXCLUDED.feature_weights,
        embedding_version = EXCLUDED.embedding_version,
        updated_at = NOW()
    `,
    [
      tenantId,
      product.productId,
      semantic.documentText,
      semantic.tokens,
      JSON.stringify(semantic.featureWeights),
      semantic.embeddingVersion,
    ]
  );

  await qdrant.upsertPoints([
    {
      id: `${tenantId}:${product.productId}`,
      vector: semantic.vector,
      payload: {
        tenantId,
        productId: product.productId,
        name: product.name,
        category: product.category || null,
        description: product.description || null,
        embeddingVersion: semantic.embeddingVersion,
      },
    },
  ]);
}

async function reindexTenantProducts(client, tenantId, limit) {
  const result = await client.query(
    `
      SELECT product_id, name, category, description, metadata, is_active
      FROM products
      WHERE tenant_id = $1
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT $2
    `,
    [tenantId, limit]
  );

  let indexed = 0;
  for (const row of result.rows) {
    await upsertSemanticIndex(client, tenantId, {
      productId: row.product_id,
      name: row.name,
      category: row.category,
      description: row.description,
      metadata: row.metadata || {},
      isActive: row.is_active,
    });
    indexed += 1;
  }

  return {
    indexed,
    scanned: result.rows.length,
  };
}

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(createRequestContextMiddleware('catalog-service', logger));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createTracingMiddleware(tracer));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'catalog-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

app.get('/catalog/products', authMiddleware, async (req, res) => {
  try {
    const { error, value } = listProductsSchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { limit, offset, category, q } = value;
    const params = [req.user.tenantId];
    const clauses = ['tenant_id = $1', 'is_active = true'];

    if (category) {
      params.push(category);
      clauses.push(`category = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }

    const whereClause = clauses.join(' AND ');
    const listQuery = `
      SELECT product_id, name, category, description, price, currency, metadata, created_at
      FROM products
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countQuery = `SELECT COUNT(*) FROM products WHERE ${whereClause}`;

    const [result, countResult] = await Promise.all([
      pool.query(listQuery, [...params, limit, offset]),
      pool.query(countQuery, params),
    ]);

    res.json({
      products: result.rows,
      total: Number(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error) {
    console.error('List products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/catalog/products/:productId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT product_id, name, category, description, price, currency, metadata, created_at
        FROM products
        WHERE tenant_id = $1 AND product_id = $2 AND is_active = true
      `,
      [req.user.tenantId, req.params.productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.get('/catalog/categories', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT category, COUNT(*) AS product_count
        FROM products
        WHERE tenant_id = $1 AND is_active = true AND category IS NOT NULL AND category <> ''
        GROUP BY category
        ORDER BY product_count DESC, category ASC
      `,
      [req.user.tenantId]
    );

    res.json({
      categories: result.rows.map((row) => ({
        category: row.category,
        productCount: Number(row.product_count),
      })),
    });
  } catch (error) {
    console.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.get('/catalog/search/semantic', authMiddleware, async (req, res) => {
  try {
    const { error, value } = semanticSearchSchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const params = [req.user.tenantId];
    const clauses = ['p.tenant_id = $1', 'p.is_active = true'];

    if (value.category) {
      params.push(value.category);
      clauses.push(`p.category = $${params.length}`);
    }

    const result = await pool.query(
      `
        SELECT
          p.product_id,
          p.name,
          p.category,
          p.description,
          p.price,
          p.currency,
          p.metadata,
          pe.document_text,
          pe.semantic_tokens,
          pe.embedding_version
        FROM products p
        LEFT JOIN product_embeddings pe
          ON pe.tenant_id = p.tenant_id
         AND pe.product_id = p.product_id
        WHERE ${clauses.join(' AND ')}
      `,
      params
    );

    const ranked = result.rows
      .map((row) => ({
        ...row,
        semanticScore: scoreSemanticMatch(value.q, row),
      }))
      .filter((row) => row.semanticScore > 0)
      .sort((a, b) => b.semanticScore - a.semanticScore || String(a.name).localeCompare(String(b.name)))
      .slice(0, value.limit);

    res.json({
      query: value.q,
      strategy: 'local-keyword-semantic-v1',
      products: ranked.map((row) => ({
        productId: row.product_id,
        name: row.name,
        category: row.category,
        description: row.description,
        price: row.price !== null ? Number(row.price) : null,
        currency: row.currency,
        metadata: row.metadata,
        semanticScore: row.semanticScore,
        embeddingVersion: row.embedding_version || 'missing-index',
      })),
    });
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ error: 'Failed to search products semantically' });
  }
});

app.post('/catalog/search/reindex', authMiddleware, productWriteMiddleware, async (req, res) => {
  try {
    const { error, value } = reindexSchema.validate(req.query, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await reindexTenantProducts(client, req.user.tenantId, value.limit);
      await client.query('COMMIT');
      return res.json({
        tenantId: req.user.tenantId,
        limit: value.limit,
        indexed: result.indexed,
        scanned: result.scanned,
        strategy: 'local-keyword-semantic-v1',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Semantic reindex error:', error);
    res.status(500).json({ error: 'Failed to reindex product semantics' });
  }
});

app.get('/catalog/search/reindex/status', authMiddleware, productWriteMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          (SELECT COUNT(*) FROM products WHERE tenant_id = $1) AS product_count,
          (SELECT COUNT(*) FROM product_embeddings WHERE tenant_id = $1) AS indexed_count,
          (SELECT MAX(updated_at) FROM product_embeddings WHERE tenant_id = $1) AS last_indexed_at
      `,
      [req.user.tenantId]
    );

    const row = result.rows[0];
    res.json({
      tenantId: req.user.tenantId,
      productCount: Number(row.product_count || 0),
      indexedCount: Number(row.indexed_count || 0),
      pendingCount: Math.max(
        Number(row.product_count || 0) - Number(row.indexed_count || 0),
        0
      ),
      lastIndexedAt: row.last_indexed_at,
    });
  } catch (error) {
    console.error('Semantic reindex status error:', error);
    res.status(500).json({ error: 'Failed to load semantic reindex status' });
  }
});

app.get('/catalog/vector/status', authMiddleware, productWriteMiddleware, async (req, res) => {
  try {
    const info = await qdrant.collectionInfo();
    res.json({
      enabled: qdrant.enabled,
      collection: qdrant.collection,
      baseUrl: qdrant.baseUrl,
      info,
    });
  } catch (error) {
    res.status(500).json({
      enabled: qdrant.enabled,
      collection: qdrant.collection,
      error: error.message,
    });
  }
});

app.post('/catalog/products', authMiddleware, productWriteMiddleware, async (req, res) => {
  try {
    const { error, value } = productMutationSchema.validate(req.body, { convert: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const product = await runProductUpsertSaga({
      pool, qdrant, buildSemanticDocument, logger,
      tenantId: req.user.tenantId, value, mode: 'create',
    });

    return res.status(201).json(product);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Product ID already exists for this tenant' });
    logger.error('create_product_error', { error: error.message });
    res.status(error.status || 500).json({ error: error.message || 'Failed to create product' });
  }
});

app.put('/catalog/products/:productId', authMiddleware, productWriteMiddleware, async (req, res) => {
  try {
    const { error, value } = productMutationSchema.validate(
      { ...req.body, productId: req.params.productId },
      { convert: true }
    );
    if (error) return res.status(400).json({ error: error.details[0].message });

    const product = await runProductUpsertSaga({
      pool, qdrant, buildSemanticDocument, logger,
      tenantId: req.user.tenantId, value, mode: 'update',
    });

    return res.json(product);
  } catch (error) {
    logger.error('update_product_error', { error: error.message });
    res.status(error.status || 500).json({ error: error.message || 'Failed to update product' });
  }
});

// RAG chatbot endpoint
app.post('/catalog/chat', authMiddleware, chatbotHandler);

app.get('/catalog/openapi', (req, res) => {  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Catalog Service API',
      version: '1.0.0',
      description: 'Tenant product catalog service',
    },
    paths: {
      '/catalog/search/semantic': {
        get: {
          summary: 'Search tenant products using a local semantic-style scorer',
        },
      },
      '/catalog/search/reindex': {
        post: {
          summary: 'Rebuild semantic index entries for existing tenant products',
        },
      },
      '/catalog/search/reindex/status': {
        get: {
          summary: 'Inspect current semantic indexing coverage for a tenant',
        },
      },
      '/catalog/vector/status': {
        get: {
          summary: 'Inspect Qdrant collection connectivity and status for catalog vectors',
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
  });
});


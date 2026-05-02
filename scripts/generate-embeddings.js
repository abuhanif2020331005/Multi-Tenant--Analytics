#!/usr/bin/env node
/**
 * Product embedding generation pipeline.
 *
 * Reads all products from the database, generates semantic embeddings,
 * and upserts them into product_embeddings + Qdrant.
 *
 * Usage:
 *   node scripts/generate-embeddings.js --tenant=acme --limit=500
 *   node scripts/generate-embeddings.js --all
 */

require('dotenv').config();
const { Pool } = require('pg');
const { buildSemanticDocument } = require('../shared/ai/semantic');
const { createQdrantClient } = require('../shared/ai/qdrant');

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split('=');
  acc[key.replace(/^--/, '')] = value || true;
  return acc;
}, {});

const tenantSlug = args.tenant || null;
const limit = Number(args.limit || 1000);
const all = Boolean(args.all);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'platform_user',
  password: process.env.DB_PASSWORD || 'platform_pass',
  database: process.env.DB_NAME || 'platform_db',
});

const qdrant = createQdrantClient({
  logger: {
    info: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
    error: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
  },
});

async function main() {
  console.log('Starting product embedding generation...');
  console.log({ tenantSlug, limit, all, qdrantEnabled: qdrant.enabled });

  const client = await pool.connect();

  try {
    let query = `
      SELECT
        p.tenant_id,
        p.product_id,
        p.name,
        p.category,
        p.description,
        p.metadata,
        p.is_active,
        t.slug AS tenant_slug
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.is_active = true
    `;

    const params = [];
    if (tenantSlug && !all) {
      params.push(tenantSlug);
      query += ` AND t.slug = $1`;
    }

    query += ` ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await client.query(query, params);
    console.log(`Found ${result.rows.length} products to process.`);

    let indexed = 0;
    for (const row of result.rows) {
      const semantic = buildSemanticDocument({
        productId: row.product_id,
        name: row.name,
        category: row.category,
        description: row.description,
        metadata: row.metadata || {},
      });

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
          row.tenant_id,
          row.product_id,
          semantic.documentText,
          semantic.tokens,
          JSON.stringify(semantic.featureWeights),
          semantic.embeddingVersion,
        ]
      );

      if (qdrant.enabled) {
        await qdrant.upsertPoints([
          {
            id: `${row.tenant_id}:${row.product_id}`,
            vector: semantic.vector,
            payload: {
              tenantId: row.tenant_id,
              productId: row.product_id,
              name: row.name,
              category: row.category || null,
              description: row.description || null,
              embeddingVersion: semantic.embeddingVersion,
            },
          },
        ]);
      }

      indexed += 1;
      if (indexed % 50 === 0) {
        console.log(`Indexed ${indexed}/${result.rows.length}...`);
      }
    }

    console.log(`✅ Indexed ${indexed} products.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Embedding generation failed:', error.message);
  process.exit(1);
});

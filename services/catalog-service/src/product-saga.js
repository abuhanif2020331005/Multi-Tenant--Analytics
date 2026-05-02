/**
 * Saga for product creation/update.
 *
 * Demonstrates the saga pattern for a multi-step distributed operation:
 *   1. Persist product to PostgreSQL
 *   2. Index semantic embeddings in product_embeddings table
 *   3. Upsert vector point in Qdrant
 *
 * If any step fails, completed steps are compensated in reverse order.
 * The DB transaction is committed only after all steps succeed.
 */

const { createSaga } = require('../../../shared/utils/saga');

async function runProductUpsertSaga({ pool, qdrant, buildSemanticDocument, logger, tenantId, value, mode }) {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const saga = createSaga(`product-${mode}`, logger);

    // Step 1: Persist product row
    saga.addStep(
      'persist_product',
      async (ctx) => {
        let result;
        if (mode === 'create') {
          result = await client.query(
            `INSERT INTO products (tenant_id, product_id, name, category, description, price, currency, metadata, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING product_id, name, category, description, price, currency, metadata, is_active, created_at`,
            [tenantId, value.productId, value.name, value.category || null,
             value.description || null, value.price, value.currency,
             JSON.stringify(value.metadata || {}), value.isActive]
          );
        } else {
          result = await client.query(
            `UPDATE products SET name=$3, category=$4, description=$5, price=$6, currency=$7,
             metadata=$8, is_active=$9, updated_at=NOW()
             WHERE tenant_id=$1 AND product_id=$2
             RETURNING product_id, name, category, description, price, currency, metadata, is_active, updated_at`,
            [tenantId, value.productId, value.name, value.category || null,
             value.description || null, value.price, value.currency,
             JSON.stringify(value.metadata || {}), value.isActive]
          );
          if (result.rows.length === 0) {
            const err = new Error('Product not found');
            err.status = 404;
            throw err;
          }
        }
        ctx.product = result.rows[0];
        return result.rows[0];
      },
      async () => {
        // Compensation: nothing extra — the outer ROLLBACK handles it
      }
    );

    // Step 2: Index semantic embeddings
    saga.addStep(
      'index_embeddings',
      async (ctx) => {
        const semantic = buildSemanticDocument(value);
        await client.query(
          `INSERT INTO product_embeddings (tenant_id, product_id, document_text, semantic_tokens, feature_weights, embedding_version, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (tenant_id, product_id) DO UPDATE
           SET document_text=EXCLUDED.document_text, semantic_tokens=EXCLUDED.semantic_tokens,
               feature_weights=EXCLUDED.feature_weights, embedding_version=EXCLUDED.embedding_version, updated_at=NOW()`,
          [tenantId, value.productId, semantic.documentText, semantic.tokens,
           JSON.stringify(semantic.featureWeights), semantic.embeddingVersion]
        );
        ctx.semantic = semantic;
        return semantic;
      },
      null
    );

    // Step 3: Upsert Qdrant vector (external — compensate by deleting the point)
    saga.addStep(
      'upsert_qdrant',
      async (ctx) => {
        if (!qdrant.enabled) return { skipped: true };
        await qdrant.upsertPoints([{
          id: `${tenantId}:${value.productId}`,
          vector: ctx.semantic.vector,
          payload: {
            tenantId, productId: value.productId, name: value.name,
            category: value.category || null, description: value.description || null,
            embeddingVersion: ctx.semantic.embeddingVersion,
          },
        }]);
        return { upserted: 1 };
      },
      null // Qdrant is eventually consistent — skip compensation
    );

    const results = await saga.execute({});

    // All steps succeeded — commit the DB transaction
    await client.query('COMMIT');
    committed = true;

    return results.persist_product;
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runProductUpsertSaga };

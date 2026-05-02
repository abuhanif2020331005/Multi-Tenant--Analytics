-- Migration: ensure product_embeddings table exists (idempotent)
-- This migration is safe to run multiple times.

CREATE TABLE IF NOT EXISTS product_embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id VARCHAR(100) NOT NULL,
    document_text TEXT NOT NULL,
    semantic_tokens TEXT[] DEFAULT '{}',
    feature_weights JSONB DEFAULT '{}',
    embedding_version VARCHAR(100) DEFAULT 'local-keyword-v1',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_embeddings_tenant_product
    ON product_embeddings(tenant_id, product_id);

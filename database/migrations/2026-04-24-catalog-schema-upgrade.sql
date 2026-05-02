-- Migration: bring existing catalog tables up to the current service schema.
-- Fresh databases get these columns from init.sql; upgraded volumes may not.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    description TEXT,
    price NUMERIC(10, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'USD',
    metadata JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, product_id)
);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE products
SET
    currency = COALESCE(currency, 'USD'),
    metadata = COALESCE(metadata, '{}'::jsonb),
    is_active = COALESCE(is_active, true),
    updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_products_tenant_id ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id);

DO $$
DECLARE
    acme_tenant_id UUID;
    test_tenant_id UUID;
BEGIN
    SELECT id INTO acme_tenant_id FROM tenants WHERE slug = 'acme';
    SELECT id INTO test_tenant_id FROM tenants WHERE slug = 'test';

    IF acme_tenant_id IS NOT NULL THEN
        INSERT INTO products (tenant_id, product_id, name, category, description, price, metadata) VALUES
            (acme_tenant_id, 'sku_hiking_shell', 'Stormguard Hiking Shell', 'outerwear', 'Waterproof technical shell for alpine weather.', 199.00, '{"tags":["waterproof","hiking","shell"]}'::jsonb),
            (acme_tenant_id, 'sku_trail_pack', 'Trailblazer 28L Pack', 'packs', 'Lightweight trail pack with hydration sleeve.', 129.00, '{"tags":["pack","trail","outdoor"]}'::jsonb),
            (acme_tenant_id, 'sku_base_layer', 'Merino Base Layer', 'apparel', 'Breathable merino layer for cold starts.', 79.00, '{"tags":["merino","baselayer","winter"]}'::jsonb),
            (acme_tenant_id, 'sku_trek_poles', 'Carbon Trek Poles', 'gear', 'Compact poles built for long-distance routes.', 149.00, '{"tags":["trekking","poles","gear"]}'::jsonb)
        ON CONFLICT (tenant_id, product_id) DO NOTHING;
    END IF;

    IF test_tenant_id IS NOT NULL THEN
        INSERT INTO products (tenant_id, product_id, name, category, description, price, metadata) VALUES
            (test_tenant_id, 'sku_demo_jacket', 'Demo All-Weather Jacket', 'outerwear', 'Demo catalog product for testing.', 99.00, '{"tags":["demo","jacket"]}'::jsonb)
        ON CONFLICT (tenant_id, product_id) DO NOTHING;
    END IF;
END $$;

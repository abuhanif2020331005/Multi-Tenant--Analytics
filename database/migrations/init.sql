-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tenants table
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    api_key VARCHAR(255) UNIQUE NOT NULL,
    plan VARCHAR(50) DEFAULT 'free',
    status VARCHAR(20) DEFAULT 'active',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    role VARCHAR(50) DEFAULT 'user',
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, email)
);

-- Products catalog
CREATE TABLE products (
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

-- Product semantic index for embedding-ready search
CREATE TABLE product_embeddings (
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

-- Refresh tokens
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Events table
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(255),
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Event outbox table for async processing / future broker integration
CREATE TABLE event_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(255),
    event_type VARCHAR(100) NOT NULL,
    event_payload JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    occurred_at TIMESTAMP,
    source VARCHAR(100) DEFAULT 'storefront',
    status VARCHAR(20) DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    error_message VARCHAR(500),
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Dead-letter storage for permanently failed outbox events
CREATE TABLE event_dead_letter (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    outbox_id UUID REFERENCES event_outbox(id) ON DELETE SET NULL,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(255),
    event_type VARCHAR(100) NOT NULL,
    event_payload JSONB DEFAULT '{}',
    failure_reason VARCHAR(500),
    original_status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_products_tenant_id ON products(tenant_id);
CREATE INDEX idx_products_product_id ON products(product_id);
CREATE INDEX idx_product_embeddings_tenant_product ON product_embeddings(tenant_id, product_id);
CREATE INDEX idx_events_tenant_id ON events(tenant_id);
CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_event_outbox_status_created_at ON event_outbox(status, created_at);
CREATE INDEX idx_event_dead_letter_tenant_id ON event_dead_letter(tenant_id);

-- Seed tenants
INSERT INTO tenants (name, slug, api_key, plan) VALUES
    ('Acme Corp', 'acme', 'acme_api_key_12345', 'pro'),
    ('Test Company', 'test', 'test_api_key_67890', 'free');

-- Create a function to add users (avoids shell escaping issues)
DO $$
DECLARE
    acme_tenant_id UUID;
    test_tenant_id UUID;
BEGIN
    -- Get tenant IDs
    SELECT id INTO acme_tenant_id FROM tenants WHERE slug = 'acme';
    SELECT id INTO test_tenant_id FROM tenants WHERE slug = 'test';
    
    -- Insert users with bcrypt hash for 'password123'
    -- Hash generated with: bcrypt.hashSync('password123', 10)
    INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role) VALUES
        (acme_tenant_id, 'admin@acme.com', '$2a$10$JZGVvBEHs0wYxbNaWV2Oj.mWtgher.ikPJ9WqR2fjdYkHPZSo0wbS', 'Admin', 'User', 'admin'),
        (test_tenant_id, 'test@test.com', '$2a$10$JZGVvBEHs0wYxbNaWV2Oj.mWtgher.ikPJ9WqR2fjdYkHPZSo0wbS', 'Test', 'User', 'user');

    -- Seed products
    INSERT INTO products (tenant_id, product_id, name, category, description, price, metadata) VALUES
        (acme_tenant_id, 'sku_hiking_shell', 'Stormguard Hiking Shell', 'outerwear', 'Waterproof technical shell for alpine weather.', 199.00, '{"tags":["waterproof","hiking","shell"]}'),
        (acme_tenant_id, 'sku_trail_pack', 'Trailblazer 28L Pack', 'packs', 'Lightweight trail pack with hydration sleeve.', 129.00, '{"tags":["pack","trail","outdoor"]}'),
        (acme_tenant_id, 'sku_base_layer', 'Merino Base Layer', 'apparel', 'Breathable merino layer for cold starts.', 79.00, '{"tags":["merino","baselayer","winter"]}'),
        (acme_tenant_id, 'sku_trek_poles', 'Carbon Trek Poles', 'gear', 'Compact poles built for long-distance routes.', 149.00, '{"tags":["trekking","poles","gear"]}'),
        (test_tenant_id, 'sku_demo_jacket', 'Demo All-Weather Jacket', 'outerwear', 'Demo catalog product for testing.', 99.00, '{"tags":["demo","jacket"]}');
    
    RAISE NOTICE 'Users created successfully';
END $$;

-- Verify
SELECT 'Created user: ' || email || ' (role: ' || role || ')' as status FROM users;

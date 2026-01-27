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

-- Indexes
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_events_tenant_id ON events(tenant_id);
CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

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
    
    RAISE NOTICE 'Users created successfully';
END $$;

-- Verify
SELECT 'Created user: ' || email || ' (role: ' || role || ')' as status FROM users;
-- Migration: ensure async event pipeline tables exist for upgraded databases.
-- Fresh databases get these from init.sql; existing volumes need this migration.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS event_outbox (
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

CREATE TABLE IF NOT EXISTS event_dead_letter (
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

CREATE INDEX IF NOT EXISTS idx_event_outbox_status_created_at
    ON event_outbox(status, created_at);

CREATE INDEX IF NOT EXISTS idx_event_dead_letter_tenant_id
    ON event_dead_letter(tenant_id);

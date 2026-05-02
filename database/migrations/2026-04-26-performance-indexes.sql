-- Migration: performance indexes for high-traffic query paths

-- Composite index for outbox polling (status + created_at is the hot path)
CREATE INDEX IF NOT EXISTS idx_event_outbox_status_created
    ON event_outbox(status, created_at ASC)
    WHERE status IN ('pending', 'publish_failed', 'failed');

-- Index for broker consumer deduplication lookup
CREATE INDEX IF NOT EXISTS idx_event_outbox_id_status
    ON event_outbox(id, status);

-- Partial index for active tenants only (most queries filter by active status)
CREATE INDEX IF NOT EXISTS idx_tenants_active_slug
    ON tenants(slug)
    WHERE status = 'active';

-- Composite index for event analytics queries (tenant + type + time)
CREATE INDEX IF NOT EXISTS idx_events_tenant_type_time
    ON events(tenant_id, event_type, created_at DESC);

-- Index for product event data lookups (recommendation engine)
CREATE INDEX IF NOT EXISTS idx_events_product_id
    ON events((event_data->>'productId'))
    WHERE event_data ? 'productId';

-- Index for user-scoped event queries
CREATE INDEX IF NOT EXISTS idx_events_tenant_user
    ON events(tenant_id, user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- Index for fraud detection IP lookups
CREATE INDEX IF NOT EXISTS idx_events_tenant_ip_time
    ON events(tenant_id, ip_address, created_at DESC)
    WHERE event_type = 'purchase';

-- Index for refresh token cleanup (expired token pruning)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens(expires_at);

-- Materialized view for daily event aggregates (analytics dashboard)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_event_counts AS
SELECT
    tenant_id,
    event_type,
    DATE_TRUNC('day', created_at) AS event_date,
    COUNT(*) AS event_count,
    COUNT(DISTINCT user_id) AS unique_users
FROM events
GROUP BY tenant_id, event_type, DATE_TRUNC('day', created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_event_counts
    ON mv_daily_event_counts(tenant_id, event_type, event_date);

-- Function to refresh the materialized view (call periodically)
CREATE OR REPLACE FUNCTION refresh_daily_event_counts()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_event_counts;
END;
$$ LANGUAGE plpgsql;

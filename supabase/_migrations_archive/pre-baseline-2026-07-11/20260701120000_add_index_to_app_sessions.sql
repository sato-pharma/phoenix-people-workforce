CREATE INDEX CONCURRENTLY IF NOT EXISTS app_sessions_heartbeat_idx
ON app_sessions (id, revoked_at, absolute_expires_at, idle_expires_at);
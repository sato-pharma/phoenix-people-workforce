-- CONCURRENTLY omitted: apply_migration runs inside a transaction and CONCURRENTLY cannot run in a transaction block.
-- IF NOT EXISTS makes this idempotent; the brief exclusive lock on app_auth_users is negligible (small table).
CREATE UNIQUE INDEX IF NOT EXISTS app_auth_users_login_id_idx ON public.app_auth_users (lower(login_id));
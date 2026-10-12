-- REVIEW ONLY. Separate approval and non-production rehearsal required.
-- No broad PUBLIC revocation. These are new functions, not changes to existing functions.
BEGIN;
CREATE FUNCTION public.phoenix_mcp_source_watermark() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',pg_current_wal_lsn()::text||':'||pg_current_snapshot()::text,
                          'observedAt',clock_timestamp());
$$;
REVOKE ALL ON FUNCTION public.phoenix_mcp_source_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_mcp_source_watermark() TO phoenix_mcp_source_reader;

-- A narrow Auth-only definer: subject is pinned in SQL as well as in the source endpoint.
-- Owner must be a reviewed role able to SELECT these Auth columns; never grant that role
-- to the source reader. No input identifiers or dynamic SQL are executed.
CREATE FUNCTION public.phoenix_mcp_auth_status(p_subject uuid)
RETURNS TABLE(id uuid,deleted boolean,banned_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,(u.deleted_at IS NOT NULL),u.banned_until FROM auth.users u
 WHERE u.id=p_subject AND p_subject='OWNER_SUBJECT'::uuid;
$$;
REVOKE ALL ON FUNCTION public.phoenix_mcp_auth_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_mcp_auth_status(uuid) TO phoenix_mcp_source_reader;
COMMIT;
-- Source reader: NOLOGIN, no memberships or elevated role flags. Give its PostgREST JWT
-- only to the private source process. GET requests are READ ONLY at the DB transaction.
-- Exact SELECT/RPC dependency grants and existing RLS acceptance must be rehearsed against
-- the matching Phoenix schema; do not grant all tables or service_role to bypass a failure.

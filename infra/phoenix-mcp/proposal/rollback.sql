-- REVIEW ONLY: stop the isolated MCP and publisher services first.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'phoenix_mcp_reporting' THEN RAISE EXCEPTION 'isolated database required'; END IF;
END $$;
ALTER ROLE phoenix_mcp_reader NOLOGIN;
ALTER ROLE phoenix_mcp_publisher NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname=current_database() AND usename IN ('phoenix_mcp_reader','phoenix_mcp_publisher') AND pid<>pg_backend_pid();
DROP TABLE phoenix_mcp.published_sales,phoenix_mcp.organization,phoenix_mcp.vacancies,phoenix_mcp.employees,phoenix_mcp.snapshots;
DROP TABLE phoenix_mcp.contract;
DROP SCHEMA phoenix_mcp;
-- No CASCADE, no production changes, no business data restoration.
REVOKE CONNECT ON DATABASE phoenix_mcp_reporting FROM phoenix_mcp_reader,phoenix_mcp_publisher;
COMMIT;
-- Keep disabled roles until the isolated database is retired; default-ACL dependencies
-- deliberately prevent casually dropping the owner. Never DROP OWNED in Phoenix.

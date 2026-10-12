-- REVIEW ONLY. New, empty, isolated database only. Never run in Phoenix/Supabase.
-- Replace OWNER_SUBJECT and SOURCE_REVISION through approved secret/config delivery.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'phoenix_mcp_reporting' THEN RAISE EXCEPTION 'isolated database required'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema')
 THEN RAISE EXCEPTION 'database must be empty'; END IF;
END $$;
CREATE ROLE phoenix_mcp_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE phoenix_mcp_publisher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
CREATE ROLE phoenix_mcp_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
-- Only this NEW database. No production PUBLIC permission changes.
REVOKE ALL ON DATABASE phoenix_mcp_reporting FROM PUBLIC;
GRANT CONNECT ON DATABASE phoenix_mcp_reporting TO phoenix_mcp_reader, phoenix_mcp_publisher;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER ROLE phoenix_mcp_reader SET default_transaction_read_only = on;
ALTER ROLE phoenix_mcp_reader SET statement_timeout = '3s';
ALTER ROLE phoenix_mcp_reader SET lock_timeout = '500ms';
ALTER ROLE phoenix_mcp_reader SET idle_in_transaction_session_timeout = '5s';
CREATE SCHEMA phoenix_mcp AUTHORIZATION phoenix_mcp_owner;
SET ROLE phoenix_mcp_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA phoenix_mcp REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA phoenix_mcp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE phoenix_mcp.contract (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version=2), source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{40}$'),
 owner_subject uuid NOT NULL
);
INSERT INTO phoenix_mcp.contract VALUES(true,2,'SOURCE_REVISION','OWNER_SUBJECT');
CREATE TABLE phoenix_mcp.snapshots (
 subject uuid NOT NULL, dataset text NOT NULL CHECK(dataset IN ('employees','vacancies','organization','published_sales')),
 period text NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 PRIMARY KEY(subject,dataset,period)
);
CREATE TABLE phoenix_mcp.employees(subject uuid NOT NULL,record_key text NOT NULL,payload jsonb NOT NULL CHECK(octet_length(payload::text)<=16000),PRIMARY KEY(subject,record_key));
CREATE TABLE phoenix_mcp.vacancies(LIKE phoenix_mcp.employees INCLUDING ALL);
CREATE TABLE phoenix_mcp.organization(LIKE phoenix_mcp.employees INCLUDING ALL);
CREATE TABLE phoenix_mcp.published_sales(subject uuid NOT NULL,period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),record_key text NOT NULL,payload jsonb NOT NULL CHECK(octet_length(payload::text)<=16000),PRIMARY KEY(subject,period,record_key));
GRANT USAGE ON SCHEMA phoenix_mcp TO phoenix_mcp_reader,phoenix_mcp_publisher;
GRANT SELECT ON ALL TABLES IN SCHEMA phoenix_mcp TO phoenix_mcp_reader;
GRANT SELECT ON phoenix_mcp.contract TO phoenix_mcp_publisher;
GRANT SELECT,INSERT,UPDATE,DELETE ON phoenix_mcp.snapshots,phoenix_mcp.employees,phoenix_mcp.vacancies,phoenix_mcp.organization,phoenix_mcp.published_sales TO phoenix_mcp_publisher;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['snapshots','employees','vacancies','organization','published_sales'] LOOP
  EXECUTE format('ALTER TABLE phoenix_mcp.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE phoenix_mcp.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY reader_scope ON phoenix_mcp.%I FOR SELECT TO phoenix_mcp_reader USING(subject=(SELECT owner_subject FROM phoenix_mcp.contract) AND subject::text=current_setting(''phoenix_mcp.subject'',true))',t);
  EXECUTE format('CREATE POLICY publisher_scope ON phoenix_mcp.%I TO phoenix_mcp_publisher USING(subject=(SELECT owner_subject FROM phoenix_mcp.contract)) WITH CHECK(subject=(SELECT owner_subject FROM phoenix_mcp.contract))',t);
 END LOOP;
END $$;
RESET ROLE;
COMMIT;
-- Passwords and TLS are provisioned out-of-band only after approval; no secrets in SQL.

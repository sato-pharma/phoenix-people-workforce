-- Temp-file spill logging guardrail (2026-07-02->04 incident follow-up).
--
-- The 2026-07-02->04 production incident was caused by undersized work_mem
-- (~2MB) forcing Source-of-Sales / Marketing ROI analytics queries to spill
-- ~161GB of temp files, saturating Disk-IO and degrading the whole platform.
-- work_mem was raised (per-ROLE, not database-wide: anon/authenticated/
-- service_role all carry work_mem=32MB in pg_roles.rolconfig, plus
-- per-function overrides of 96-128MB on phx_exec_customers /
-- phx_customer_directory) and that fix is holding - verified live: zero
-- temp_blks_written across the top-20 queries by execution time since the
-- 2026-07-05 pg_stat_statements reset.
--
-- log_temp_files was -1 (disabled): no log visibility when ANY query spills
-- to disk, regardless of size. This is exactly why the incident took manual
-- pg_stat_statements forensics to diagnose instead of showing up in logs
-- within minutes. A 10MB+ threshold surfaces spills directly in Postgres
-- logs going forward, without noise from small/expected temp-file uses.
--
-- log_temp_files is a Postgres 'superuser'-context GUC. `alter database
-- postgres set log_temp_files = ...` is permission-denied on Supabase's
-- managed platform (confirmed) - but `alter role <role> set log_temp_files
-- = ...` IS accepted, on a per-role allowlist basis (mechanism: the
-- `authenticator` role's `session_preload_libraries` includes `supautils`,
-- Supabase's own extension for permitting a curated set of otherwise-
-- superuser-only settings at the role level). This mirrors exactly how
-- work_mem was deployed for this same incident - per-role, not per-database.
--
-- Applied to every role that either logs in directly (postgres, authenticator)
-- or that PostgREST's per-request role-switching activates for live traffic
-- (anon, authenticated, service_role) - the same role set work_mem already
-- covers.
--
-- NOTE: temp_file_limit (a bounded per-session temp-file ceiling, the other
-- half of this guardrail) remains genuinely blocked - confirmed permission-
-- denied via `alter database`, `alter role postgres`, and `alter role
-- authenticator` alike (unlike log_temp_files, no role-level path exists for
-- it on this platform). It is NOT on whatever allowlist supautils/Supabase
-- uses for log_temp_files. Tracked separately: requires a Supabase dashboard
-- "Custom Postgres Config" entry or a support ticket, not achievable via SQL
-- from any role this project exposes.
--
-- Rollback: alter role postgres reset log_temp_files;
--           alter role authenticator reset log_temp_files;
--           alter role anon reset log_temp_files;
--           alter role authenticated reset log_temp_files;
--           alter role service_role reset log_temp_files;

alter role postgres set log_temp_files = 10240; -- KB (10MB)
alter role authenticator set log_temp_files = 10240;
alter role anon set log_temp_files = 10240;
alter role authenticated set log_temp_files = 10240;
alter role service_role set log_temp_files = 10240;

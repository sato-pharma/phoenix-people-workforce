-- Drop 7 dead Sales-Intelligence RPCs.
--
-- SAFE: these are DROP FUNCTION, not DROP TABLE — no data is touched. Each was verified dead in
-- production on 2026-08-02 by BOTH checks that matter:
--   1. Zero TypeScript callers  — `git grep '"<name>"' -- src app` returns nothing.
--   2. Zero SQL-side callers    — no other pg_proc.prosrc, pg_views.definition, or pg_matviews
--                                 .definition references the name.
--
-- The second check is why `phx_customer_directory` is NOT in this list: it has no TS caller, but
-- `phx_customer_directory_json` (which IS live, via src/lib/sales/customer-directory.ts) calls it
-- from SQL. Dropping it would have broken the customer directory. Re-run both checks before adding
-- anything here.
--
-- Why they are worth removing rather than leaving idle: each is SECURITY DEFINER and each declares
-- `p_exclude_codes text[] DEFAULT '{}'` — i.e. omitting the argument reveals the confidential
-- products (LA003/LA004/SS001). They are service_role-only today, so this is unused footgun rather
-- than live exposure, but an unused SECURITY DEFINER function with a fail-open confidentiality
-- default is exactly the thing that gets wired up later by someone who does not know that.
--
-- Rollback: the full bodies remain in
-- supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql.

DROP FUNCTION IF EXISTS public.phx_si_brick(p_period text, p_exclude_codes text[], p_lines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.phx_si_customer_product(p_period text, p_exclude_codes text[], p_lines text[], p_regions text[], p_product_codes text[], p_client_codes text[], p_limit integer);
DROP FUNCTION IF EXISTS public.phx_si_customers(p_period text, p_exclude_codes text[], p_lines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.phx_si_daily(p_period text, p_exclude_codes text[], p_lines text[], p_regions text[], p_product_codes text[], p_distributor_codes text[]);
DROP FUNCTION IF EXISTS public.phx_si_distributor_product(p_period text, p_exclude_codes text[], p_lines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.phx_si_period_totals(p_exclude_codes text[], p_lines text[], p_regions text[]);
DROP FUNCTION IF EXISTS public.phx_sales_marketing_dashboard(p_lines text[], p_regions text[], p_distributor_codes text[], p_product_codes text[], p_limit integer, p_exclude_codes text[]);

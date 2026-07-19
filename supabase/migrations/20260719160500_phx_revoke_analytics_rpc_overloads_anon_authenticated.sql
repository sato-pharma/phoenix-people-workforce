-- Close a LIVE, unauthenticated, company-wide sales-data leak on BOTH staging (cifwmndunmlxjhyjugxa)
-- AND production (ozucdzovmcqvepbozvqf).
--
-- Found via mcp__Supabase__get_advisors (security) while auditing the Sales Analytics module: each of
-- analytics_sos_by_area / _by_customer / _by_line / _by_period / _by_product / analytics_weekly_fact /
-- analytics_closing_by_employee carries a SECOND, undocumented overload (plural `p_periods text[]` /
-- `p_week_starts date[]`) that no committed migration defines. These overloads are SECURITY DEFINER
-- with NO auth guard, and — critically — their ACL carries the built-in Postgres default grant
-- `=X/postgres` (EXECUTE to PUBLIC). Because every login role is a member of PUBLIC, anon and
-- authenticated can call them via POST /rest/v1/rpc/analytics_sos_by_period (etc.), fully bypassing
-- the app's assertPermission + AnalyticsViewerScope line/region/product scoping, and (for
-- _by_area/_by_period) the p_exclude_head_office flag — so an anonymous holder of the public anon key
-- can pull the whole company's SoS/Weekly/Closing sales data and, with p_exclude_head_office=false,
-- the confidential Head Office line too. (The confidential-product exclusion itself stays enforced —
-- it is baked into the analytics.sos_fact / analytics.weekly_fact view WHERE clause regardless of
-- caller; see 20260719153000.)
--
-- IMPORTANT — the grant is via PUBLIC, not a direct anon/authenticated grant. Verified live with
-- pg_proc.proacl: the vulnerable overloads show `=X/postgres | postgres=X/postgres |
-- service_role=X/postgres` (the leading `=X` is the PUBLIC grant), whereas the app's real, already-safe
-- overload — analytics_closing_by_employee(p_period text, ...) — shows only `postgres=X | service_role=X`
-- (no PUBLIC entry). So the fix is `REVOKE EXECUTE ... FROM PUBLIC` (anon/authenticated added for
-- completeness); a `REVOKE ... FROM anon, authenticated` alone is a no-op against a PUBLIC grant.
--
-- The app never calls these plural overloads: every analytics_* RPC in src/lib/analytics/service.ts
-- uses the singular p_period / p_channel parameter names, which resolve to the OTHER (already-safe)
-- overload. Revoking is therefore safe and non-destructive (reversible by re-granting).
--
-- Already applied to staging AND production ahead of this file (live breach) and verified: after the
-- sweep, zero analytics_* SECURITY DEFINER functions are anon-executable on either DB. This file is
-- the idempotent, tracked record; re-running it is a no-op.

-- Explicit revokes for the seven known vulnerable signatures (audit-friendly), FROM PUBLIC + the two
-- API roles. Idempotent: revoking an absent grant is a no-op, not an error.
revoke execute on function public.analytics_closing_by_employee(
  p_periods text[], p_period_from text, p_period_to text, p_lines text[], p_products text[],
  p_families text[], p_employee_hr_id text, p_territory text, p_batch_status text[], p_batch_id uuid
) from public, anon, authenticated;

revoke execute on function public.analytics_sos_by_area(
  p_periods text[], p_period_from text, p_period_to text, p_channels text[], p_lines text[],
  p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_families text[],
  p_client_codes text[], p_exclude_head_office boolean
) from public, anon, authenticated;

revoke execute on function public.analytics_sos_by_customer(
  p_periods text[], p_period_from text, p_period_to text, p_lines text[], p_regions text[],
  p_client_codes text[]
) from public, anon, authenticated;

revoke execute on function public.analytics_sos_by_line(
  p_periods text[], p_period_from text, p_period_to text, p_channels text[], p_lines text[],
  p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_families text[],
  p_client_codes text[]
) from public, anon, authenticated;

revoke execute on function public.analytics_sos_by_period(
  p_periods text[], p_period_from text, p_period_to text, p_channels text[], p_lines text[],
  p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_families text[],
  p_client_codes text[], p_exclude_head_office boolean
) from public, anon, authenticated;

revoke execute on function public.analytics_sos_by_product(
  p_periods text[], p_period_from text, p_period_to text, p_channels text[], p_lines text[],
  p_distributors text[], p_regions text[], p_areas text[], p_products text[], p_families text[],
  p_client_codes text[]
) from public, anon, authenticated;

revoke execute on function public.analytics_weekly_fact(
  p_week_starts date[], p_years integer[], p_distributors text[], p_lines text[], p_regions text[],
  p_products text[], p_families text[]
) from public, anon, authenticated;

-- Belt-and-suspenders sweep: the seven revokes above name exact signatures, but if any analytics_*
-- SECURITY DEFINER overload is ever (re)created it would inherit the same built-in PUBLIC EXECUTE
-- grant and silently re-open the leak. This revokes PUBLIC/anon/authenticated EXECUTE from every
-- remaining public analytics_* SECURITY DEFINER function still reachable — idempotent, a no-op once
-- the explicit revokes above have run. Scoped to analytics_* to stay within this module.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'analytics\_%'
      and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated;', fn.sig);
    raise notice 'swept: revoked PUBLIC/anon/authenticated EXECUTE on %', fn.sig;
  end loop;
end $$;

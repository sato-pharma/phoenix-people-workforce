-- ============================================================================
-- Security + advisor cleanup: revoke anon EXECUTE on sales_ops_dashboard,
-- drop one duplicate marketing_requests index, pin two mutable search_paths.
-- ----------------------------------------------------------------------------
-- Source: live security/performance advisors on production (ref ozucdzovmcqvepbozvqf),
-- 2026-06-19. All three changes are additive, reversible, and verified against
-- live signatures. Each statement is guarded with an existence check so this
-- migration applies cleanly BOTH on production (where every object exists) AND
-- on any environment rebuilt purely from this repo (where sales_ops_dashboard is
-- not present, because its CREATE was applied directly to prod and never landed
-- in the repo -- a known drift this migration deliberately does not depend on).
--
-- ----------------------------------------------------------------------------
-- 1) HIGH (confidentiality): public.sales_ops_dashboard(text)
--    Advisor 0028 (anon_security_definer_function_executable). The function is
--    SECURITY DEFINER (bypasses RLS) and currently grants EXECUTE to PUBLIC, so
--    the `anon` role -- reachable by anyone holding the public anon API key that
--    ships in the browser bundle -- can call /rest/v1/rpc/sales_ops_dashboard and
--    read the company-wide sales snapshot WITHOUT signing in. Today the snapshot
--    holds only a placeholder row (period 2026-04, ~117 bytes), but the door is
--    open for when the new sales-ops platform fills it with real aggregates.
--    Fix: revoke EXECUTE from public + anon. KEEP `authenticated` (logged-in
--    dashboard reads) and `service_role` (server reads). No app code references
--    this RPC on main, so there is zero current application impact.
--    Stricter follow-up (NOT done here): also revoke `authenticated` and force
--    all reads through the server -- defer until the eventual call path is known.
--
-- 2) LOW (performance, advisor 0009 duplicate_index): marketing_requests has two
--    byte-identical indexes on (status, pay_date) INCLUDE (...) WHERE pay_date IS
--    NOT NULL: ..._smi_... (created 20260618155611) and ..._mroi_... (created
--    20260618174903). Keep the later "_mroi_" (refocus) index; drop the "_smi_"
--    duplicate to remove redundant write overhead. End state is identical either
--    way; this only trims one index maintenance cost on writes.
--
-- 3) LOW (security, advisor 0011 function_search_path_mutable): two SECURITY
--    INVOKER functions have no fixed search_path. Pin to `public, pg_temp`
--    (same convention as 20260615093000_pin_function_search_path.sql). Behaviour
--    is unchanged; this only removes search-path ambiguity. Reversible with RESET.
--      - public.phx_weekly_plan_next_status(text, text, boolean)
--      - public.set_sidebar_module_assignments_updated_at()
--
-- ----------------------------------------------------------------------------
-- Rollback (manual, if ever needed):
--   grant execute on function public.sales_ops_dashboard(text) to anon;          -- (1) re-open to anon
--   -- (2) recreate the dropped index:
--   create index if not exists marketing_requests_smi_status_pay_date_idx
--     on public.marketing_requests using btree (status, pay_date)
--     include (id, request_code, customer_id, line_id, estimated_cost,
--              required_roi_value, expected_roi_value, roi_duration_months,
--              roi_coverage_ratio)
--     where (pay_date is not null);
--   alter function public.phx_weekly_plan_next_status(text, text, boolean) reset search_path;  -- (3)
--   alter function public.set_sidebar_module_assignments_updated_at() reset search_path;        -- (3)
-- ============================================================================

-- 1) Revoke anonymous EXECUTE on the SECURITY DEFINER sales dashboard function.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'sales_ops_dashboard'
      and pg_get_function_identity_arguments(p.oid) = 'p_period text'
  ) then
    execute 'revoke execute on function public.sales_ops_dashboard(text) from public';
    execute 'revoke execute on function public.sales_ops_dashboard(text) from anon';
    -- Re-assert the intended end state (idempotent): logged-in + server only.
    execute 'grant  execute on function public.sales_ops_dashboard(text) to authenticated';
    execute 'grant  execute on function public.sales_ops_dashboard(text) to service_role';
  end if;
end
$$;

-- 2) Drop the duplicate marketing_requests index (keep the "_mroi_" twin).
drop index if exists public.marketing_requests_smi_status_pay_date_idx;

-- 3) Pin search_path on the two flagged SECURITY INVOKER functions.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'phx_weekly_plan_next_status'
      and pg_get_function_identity_arguments(p.oid) = 'current_status text, action text, has_comment boolean'
  ) then
    execute 'alter function public.phx_weekly_plan_next_status(text, text, boolean) set search_path = public, pg_temp';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_sidebar_module_assignments_updated_at'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute 'alter function public.set_sidebar_module_assignments_updated_at() set search_path = public, pg_temp';
  end if;
end
$$;

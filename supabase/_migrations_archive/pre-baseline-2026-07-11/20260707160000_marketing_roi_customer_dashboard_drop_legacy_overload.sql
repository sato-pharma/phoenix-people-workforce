-- Drop the orphaned 10-arg phx_marketing_roi_customer_dashboard overload.
--
-- Two overloads currently coexist in production:
--   - An 11-arg version (with p_exclude_codes, added 20260623090000) already
--     correctly locked to service_role-only.
--   - A legacy 10-arg version, left over from before that migration, still
--     EXECUTE-able by anon/authenticated/service_role per the security
--     advisor - and missing the LA003/LA004/SS001 confidential-product
--     exclusion entirely, since that exclusion was only added to the 11-arg
--     body.
--
-- This is NOT the same situation as phx_marketing_roi_fast's grant drift
-- (20260705180000): the 11-arg signature here was never mis-granted, it has
-- been service_role-only since 20260623090000. The problem is the OLD
-- signature was simply never dropped when the new one was introduced,
-- leaving a second, unfiltered, publicly-callable door into the same data.
--
-- Confirmed (repo-wide grep, 2026-07-07): the only two real callers are
--   - src/lib/sales-marketing-intelligence/service.ts - already passes
--     p_exclude_codes, resolves to the 11-arg overload. No change needed.
--   - scripts/source-of-sales-warning-cleanup.ts - did NOT pass
--     p_exclude_codes, so it resolved to this legacy 10-arg overload.
--     Fixed in the same change to pass p_exclude_codes: [], so it now
--     resolves to the 11-arg overload too.
-- No Supabase Edge Function, test file, or other caller references the
-- 10-arg form (only edge function in the project is unrelated: summarize-thread).
--
-- The real fix is not re-granting permissions on a signature that should not
-- exist - it's removing the dead, insecure, non-compliant path entirely.
--
-- Rollback: recreate from git history (20260618174903, refined by
-- 20260622100000_marketing_roi_rpc_statement_timeout.sql) if ever needed -
-- not expected, since the 11-arg overload is a strict superset (p_exclude_codes
-- defaults to '{}'::text[], i.e. "exclude nothing", matching old behavior for
-- any caller that doesn't care about the exclusion).

drop function if exists public.phx_marketing_roi_customer_dashboard(
  text[], text[], text[], text[], text[], text[], text, text, text, integer
);

notify pgrst, 'reload schema';

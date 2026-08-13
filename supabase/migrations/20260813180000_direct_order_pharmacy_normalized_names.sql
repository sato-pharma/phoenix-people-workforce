-- Batch-normalize pharmacy names, for the code-less duplicate-detection fallback (owner, 2026-08-13).
--
-- groupDuplicatePharmacies (src/lib/direct-orders/duplicate-resolution.ts) matches purely on
-- distributor/customer code pairs. A pharmacy registered with NO code at all — explicitly allowed,
-- "owner rule 2026-08-04": a rep who does not know the code must never be blocked — carries zero
-- identity keys and is therefore invisible to that matcher forever, however many times the same
-- real place gets typed in under a fresh registration.
--
-- CONFIRMED LIVE 2026-08-13. "حضانه زمزم", area D15, registered twice the same day by the same
-- rep (b-154): DOP-000018 and DOP-000019, neither carrying a code, neither ever surfaced by the
-- existing cleanup queue — and structurally never would be, since that queue's only matcher is
-- code-based.
--
-- THE ONLY NEW OBJECT this migration adds: a batched read of phx_normalize_arabic(pharmacy_name)
-- for a set of pharmacy ids, so the TypeScript dedupe logic can add a name+area fallback WITHOUT
-- reimplementing Arabic normalization. phx_normalize_arabic (20260807120000) is the one place that
-- folding logic lives — duplicating it in TypeScript would drift the moment either copy changed,
-- exactly the failure mode this codebase avoids everywhere else (HELD_ORDER_LIFETIME_DAYS,
-- the flag-placement note in claims-read-flag.ts, and others).
--
-- security invoker, same as phx_search_direct_order_customers: the caller's own privileges govern
-- what direct_order_pharmacies rows are visible, this function adds no privilege of its own.
create or replace function public.phx_direct_order_pharmacy_normalized_names(p_ids uuid[])
returns table (id uuid, normalized_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, public.phx_normalize_arabic(p.pharmacy_name)
    from public.direct_order_pharmacies p
   where p.id = any(coalesce(p_ids, array[]::uuid[]))
$$;

revoke all on function public.phx_direct_order_pharmacy_normalized_names(uuid[]) from public;
grant execute on function public.phx_direct_order_pharmacy_normalized_names(uuid[]) to service_role;

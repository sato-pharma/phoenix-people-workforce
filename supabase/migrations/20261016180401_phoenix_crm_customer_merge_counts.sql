-- =============================================================================
-- Phoenix CRM — the three counts the duplicate list's keep rule reads, counted in the database.
--
-- WHAT: one read function, public.phoenix_crm_customer_merge_counts(uuid[]), answering a single jsonb
--      object for the customers asked about:
--        { "active_places": { customer_id: n }, "visits": { customer_id: n }, "moves": { customer_id: n } }
--      — how many ACTIVE places each customer has, how many visits were ever saved against it, and how
--      many times it was moved between lists. A customer with none of one kind is simply absent from
--      that object, which the page reads as zero, exactly as before.
--
-- WHY (Phoenix CRM performance audit, 2026-10-16): the duplicates page (Super Admin and SFE Manager)
--      decides which of two rows the one-off merge would keep by those three counts, and it fetched
--      EVERY place, visit and move row of every duplicate to count them in the page server — a
--      doctor with a year of visits is hundreds of rows, read a thousand at a time, only to be added
--      up and thrown away. Now it is one statement and one round trip.
--
--      The counts are the page's own, unchanged: places with status 'active', every visit, every move,
--      with no is_test narrowing on any of them — because the row reads never had one — so the keep
--      rule (planMerge) sees the same three numbers and names the same keeper. A jsonb object rather
--      than a set of rows because PostgREST caps a set-returning function at 1,000 rows, silently.
--
-- SECURITY DEFINER with search_path public, revoked from public, anon and authenticated and granted
--      to service_role only, exactly like every sibling phoenix_crm read function. The page that calls
--      it is gated on the SFE Manager and the Super Admin before it asks.
--
-- ROLLBACK: drop function if exists public.phoenix_crm_customer_merge_counts(uuid[]);
--      and restore the paged row reads in src/lib/phoenix-crm/server/duplicate-customers.ts.
-- =============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_customer_merge_counts(p_customer_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'active_places', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select p.customer_id, count(*)::integer as n
        from public.phoenix_crm_places p
        where p.customer_id = any (p_customer_ids)
          and p.status = 'active'
        group by p.customer_id
      ) counted
    ), '{}'::jsonb),
    'visits', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select v.customer_id, count(*)::integer as n
        from public.phoenix_crm_visits v
        where v.customer_id = any (p_customer_ids)
        group by v.customer_id
      ) counted
    ), '{}'::jsonb),
    'moves', coalesce((
      select jsonb_object_agg(counted.customer_id, counted.n)
      from (
        select m.customer_id, count(*)::integer as n
        from public.phoenix_crm_customer_moves m
        where m.customer_id = any (p_customer_ids)
        group by m.customer_id
      ) counted
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.phoenix_crm_customer_merge_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_merge_counts(uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- Phoenix CRM — how many customers each territory's list holds, counted in the database.
--
-- WHAT: one read function, public.phoenix_crm_customer_counts_by_seat(text[]), answering a single
--      jsonb object { seat_id: count } for the seats asked about — the customers that are on the
--      list, waiting to be validated, or waiting to be added (status active, pending or outside), real
--      customers only (is_test = false).
--
-- WHY (Phoenix CRM performance audit, 2026-10-16): the SFE's list-template page printed one number
--      per territory and fetched every customer row to get it — about 11,500 rows on production,
--      walked a thousand at a time in a dozen sequential round trips across the Atlantic, only to be
--      counted in the page server and thrown away. The count is now one statement and one round trip,
--      and the seat list travels in the request body instead of a URL that a few hundred seat ids
--      would push past the header limit.
--
--      The filter is the page's own, unchanged — same seats, same three statuses, same is_test = false
--      — so every territory prints the number it printed before. A jsonb object rather than a set of
--      rows because PostgREST caps a set-returning function at 1,000 rows exactly as it caps a table
--      read, silently; one object is one value and cannot be cut short.
--
-- SECURITY DEFINER with search_path public, revoked from public, anon and authenticated and granted
--      to service_role only, exactly like every sibling phoenix_crm read function. The page that calls
--      it is gated on the SFE Manager and the Super Admin before it asks.
--
-- ROLLBACK: drop function if exists public.phoenix_crm_customer_counts_by_seat(text[]);
--      and restore the paged row read in src/lib/phoenix-crm/server/list-template.ts.
-- =============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_customer_counts_by_seat(p_seat_ids text[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_object_agg(counted.seat_id, counted.customers), '{}'::jsonb)
  from (
    select c.seat_id, count(*)::integer as customers
    from public.phoenix_crm_customers c
    where c.seat_id = any (p_seat_ids)
      and c.is_test = false
      and c.status in ('active', 'pending', 'outside')
    group by c.seat_id
  ) counted;
$$;

revoke execute on function public.phoenix_crm_customer_counts_by_seat(text[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_counts_by_seat(text[]) to service_role;

notify pgrst, 'reload schema';

commit;

-- phoenix_crm_customer_visit_tally
--
-- WHAT THIS CHANGES: adds one read-only function, public.phoenix_crm_customer_visit_tally(seat ids,
--   is_test, month start, through). For every customer a territory has visited it answers ONE row:
--   the day of the last visit, the visits this month and the visits in total. Nothing is written,
--   no table or view changes.
-- WHY: owner, 19 Nov 2026 — every screen that shows a rep's weekly plan must show, for each doctor,
--   when he was last visited, how many visits he had this month and how many in total. The figures
--   come from phoenix_crm_countable_visits_with_history — the SAME view and the same window the
--   planner's "visits this month" already reads (loadMonthVisitCounts), so the month figure on a plan
--   row and the one on every other screen are one number. That view holds Phoenix's own visits and
--   the iReports360 history copied into Phoenix (from 1 Jan 2026), never an off-plan visit nobody
--   approved, a held far visit, or an archived row. Counted in SQL, one row per customer, never by
--   paging every visit to the app (crm-board-reads: "COUNT A CONTACT'S HISTORY IN SQL").
--   contact_crm_id is coalesce(reference_contact_crm_id, own_contact_crm_id) — the id every CRM door
--   emits — so the Reps List's plan tab, which is keyed by contact, reads the same row.
-- ROLLBACK: drop function if exists public.phoenix_crm_customer_visit_tally(text[], boolean, date, date);
--   Nothing else depends on it; the app treats a failed read as "no figures" and the plan still opens.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: one new read-only function.

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_customer_visit_tally(
  p_seat_ids text[],
  p_is_test boolean,
  p_month_start date,
  p_through date
)
returns table (
  seat_id text,
  customer_id uuid,
  contact_crm_id bigint,
  last_visit_on date,
  month_visits integer,
  total_visits integer
)
language sql
stable
security definer
set search_path to 'public'
as $$
  -- Grouped BEFORE the customer join, so the customers are looked up once per row by their key
  -- rather than hashed whole (measured 19 Nov 2026: the six busiest territories in ~0.1 s).
  with tally as (
    select
      v.seat_id,
      v.customer_id,
      max(v.visit_date) as last_visit_on,
      (count(*) filter (where v.visit_date >= p_month_start))::integer as month_visits,
      count(*)::integer as total_visits
    from public.phoenix_crm_countable_visits_with_history v
    where v.seat_id = any (p_seat_ids)
      and v.is_test = p_is_test
      and v.visit_date <= p_through
      and v.customer_id is not null
    group by v.seat_id, v.customer_id
  )
  select
    t.seat_id,
    t.customer_id,
    coalesce(c.reference_contact_crm_id, c.own_contact_crm_id) as contact_crm_id,
    t.last_visit_on,
    t.month_visits,
    t.total_visits
  from tally t
  left join public.phoenix_crm_customers c on c.id = t.customer_id
  order by t.seat_id, t.customer_id;
$$;

comment on function public.phoenix_crm_customer_visit_tally(text[], boolean, date, date) is
  'Per customer of each territory: last visit day, visits this month, visits in total — from phoenix_crm_countable_visits_with_history (owner, 19 Nov 2026: every rep weekly plan screen shows them).';

revoke execute on function public.phoenix_crm_customer_visit_tally(text[], boolean, date, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_visit_tally(text[], boolean, date, date) to service_role;

notify pgrst, 'reload schema';

commit;

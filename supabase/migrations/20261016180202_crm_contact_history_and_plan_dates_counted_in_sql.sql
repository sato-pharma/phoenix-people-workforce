-- The List's iReports360 history and reference plan days are counted in the database, one row per contact.
--
-- WHY (2026-10-16 Phoenix CRM performance audit). The Phoenix CRM List and planner ask the iReports360 mirror
-- two questions per reference customer: how many visits it holds on him and the last one's day (plus,
-- for the planner, the days of the last 91), and the days of his reference plans over four months. Both
-- were answered by reading EVERY matching row of a union view to the app — 50 contacts per request, a
-- page of 1,000 at a time by OFFSET — and counting there. A doctor seen weekly for two years is a
-- hundred rows; a territory is a few hundred doctors; and an OFFSET page over a union view makes the
-- database rebuild every page before it, so the cost grew with the square of the history. The app needs
-- one count, one date and one list of days per contact.
--
-- WHAT IT ADDS: two read functions, each the same filter over the same view the app read, aggregated:
--   phx_crm_contact_visit_history(contact ids, days_since) — over crm_visits_unified, iReports360 rows only
--     (source = 'ireports360', exactly the app's `.eq("source", IREPORTS360_VISIT_SOURCE)`): per contact,
--     count(*), max(visit_date) and, only when days_since is given, the visit days on or after it, newest
--     first. readContactVisitHistory (src/lib/crm/reads.ts, the read door) calls it.
--   phx_crm_contact_plan_dates(contact ids, from) — over crm_plan_entries_unified, iReports360 rows only,
--     plan_date not null and on or after `from`: per contact, every plan day, newest first, duplicates kept
--     (a day planned twice weighs twice in the pattern, as it did). loadPlanDatesFor
--     (src/lib/crm/shared-customers.ts) calls it.
--
-- NO FIGURE CHANGES. The rows are the ones the app filtered — same view, same source, same contacts, same
-- window — and the fold it ran (count, the first date of a newest-first walk, the days on or after the
-- window) is what the aggregate computes: visit_date and plan_date are filtered NOT NULL where it matters,
-- max() of a newest-first walk is its first row, and array_agg keeps every day in the same order. The one
-- difference is in the app's favour: an OFFSET walk ordered by a date alone could repeat or skip a row
-- where many share one day across a page boundary; an aggregate cannot. Not bounded by any new date: the
-- history is still every visit the mirror holds.
--
-- Both views are security_invoker; these functions are SECURITY DEFINER (search_path 'public'), so they
-- read as their owner, exactly as the service role read them, and are executable by the service role
-- only. Until they are applied, both callers fall back to their page walks (PGRST202).
--
-- ROLLBACK:
--   drop function if exists public.phx_crm_contact_visit_history(bigint[], date);
--   drop function if exists public.phx_crm_contact_plan_dates(bigint[], date);

begin;

set local lock_timeout = '5s';

create or replace function public.phx_crm_contact_visit_history(
  p_contact_crm_ids bigint[],
  p_days_since date default null
)
returns table (
  contact_crm_id bigint,
  visits integer,
  last_visited_on date,
  days date[]
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.contact_crm_id,
    count(*)::integer,
    max(v.visit_date),
    case
      when p_days_since is null then null
      else array_agg(v.visit_date order by v.visit_date desc) filter (where v.visit_date >= p_days_since)
    end
  from public.crm_visits_unified v
  where v.source = 'ireports360'
    and v.contact_crm_id = any (p_contact_crm_ids)
  group by v.contact_crm_id
  order by v.contact_crm_id;
$$;

comment on function public.phx_crm_contact_visit_history(bigint[], date) is
  'Per iReports360 contact: how many iReports360 visits the read door holds (crm_visits_unified, source '
  '''ireports360''), the last one''s day, and — when p_days_since is given — the visit days on or after it, '
  'newest first. Read by readContactVisitHistory (src/lib/crm/reads.ts). See '
  'supabase/migrations/20261016180202_crm_contact_history_and_plan_dates_counted_in_sql.sql.';

create or replace function public.phx_crm_contact_plan_dates(
  p_contact_crm_ids bigint[],
  p_from date
)
returns table (
  contact_crm_id bigint,
  plan_dates date[]
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    p.contact_crm_id,
    array_agg(p.plan_date order by p.plan_date desc)
  from public.crm_plan_entries_unified p
  where p.source = 'ireports360'
    and p.contact_crm_id = any (p_contact_crm_ids)
    and p.plan_date is not null
    and p.plan_date >= p_from
  group by p.contact_crm_id
  order by p.contact_crm_id;
$$;

comment on function public.phx_crm_contact_plan_dates(bigint[], date) is
  'Per iReports360 contact: every iReports360 reference plan day on or after p_from (crm_plan_entries_unified, '
  'source ''ireports360''), newest first, duplicates kept. Read by loadPlanDatesFor '
  '(src/lib/crm/shared-customers.ts). See '
  'supabase/migrations/20261016180202_crm_contact_history_and_plan_dates_counted_in_sql.sql.';

revoke execute on function public.phx_crm_contact_visit_history(bigint[], date) from public, anon, authenticated;
grant execute on function public.phx_crm_contact_visit_history(bigint[], date) to service_role;
revoke execute on function public.phx_crm_contact_plan_dates(bigint[], date) from public, anon, authenticated;
grant execute on function public.phx_crm_contact_plan_dates(bigint[], date) to service_role;

notify pgrst, 'reload schema';

commit;

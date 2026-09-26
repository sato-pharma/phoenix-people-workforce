-- phoenix_crm_report_brick_coverage
--
-- WHAT THIS CHANGES: one new read-only function. No table, no column, no policy, no data.
--
-- WHY IT EXISTS (C2 of the owner's Phoenix CRM plan, 2026-09-26). A manager can see how many
-- customers a rep covered and, on a different screen, what an area sold. Nobody can see the two
-- together at the grain where a rep actually works, which is the BRICK. This answers "of the bricks
-- my line sells into, which ones does this rep's list even reach, and how often does he go there".
--
-- 🔴 THE COVERAGE HALF IS COMPUTED NATIVELY AND NEVER JOINED TO THE VENDOR'S CRM. `phoenix_crm_places`
-- already carries `brick_id`, `brick_name`, `area_code` and `area_name` RESOLVED SERVER-SIDE AT
-- CAPTURE and frozen there (owner, 2026-09-23: a captured place's location is never editable). So the
-- brick a customer sits in is a fact this module already owns, and re-deriving it from iReports360
-- would be both slower and wrong — the vendor's brick map is the one Phoenix replaced.
--
-- 🔴 THE SALES HALF IS NOT IN HERE, DELIBERATELY. `phx_closing_brick` lives on the other side of the
-- El Qema mask: its rows must pass `withoutMaskedSourceRows` before anything is summed, or a
-- warehouse brick carrying El Qema's stock announces a source only the Super Admin may see. A mask is
-- a TypeScript rule with a viewer's role in it, so it cannot live in SQL — the caller composes the two
-- halves (src/lib/phoenix-crm/server/brick-report.ts), exactly as the list board composes its own.
--
-- 🔴 A BRICK'S SALES NEVER SUM TO THE AREA'S CLOSING FIGURE. The caller carries the caveat; see
-- src/lib/sales/closing-brick-sales.ts.
--
-- WHAT IT COUNTS, per seat per brick:
--   customers      validated customers of that seat whose ACTIVE place sits in the brick
--   am / pm        the same, split by list type — AM and PM are never summed (the call-rate rule)
--   visited        those with at least one COUNTABLE visit in the window
--   visits         countable visits in the window, whatever the place they were saved at
--
-- "Countable" is `phoenix_crm_countable_visits`, the module's one predicate for whether a visit
-- counts — an off-plan visit still waiting for its two approvals is NOT in it (owner, 2026-09-26).
--
-- A customer with NO captured place yet is not silently dropped: he lands under a null brick, so a
-- manager reading the board can see that the reason a brick looks uncovered may be that the rep has
-- not been there to capture a place at all.
--
-- SAFETY: read-only, stable, service_role only, revoked from public/anon/authenticated. Rollback is
--   drop function if exists public.phoenix_crm_report_brick_coverage(text[], date, date, boolean);

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_report_brick_coverage(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with listed as (
    -- One row per validated customer, placed on the brick of his ACTIVE place. A customer with two
    -- active places counts ONCE, at the earliest — the same rule the coverage board states on screen,
    -- so a doctor with a clinic in two bricks cannot inflate either one.
    select c.id, c.seat_id, c.list_type, place.brick_id, place.brick_name, place.area_code, place.area_name
    from public.phoenix_crm_customers c
    left join lateral (
      select p.brick_id, p.brick_name, p.area_code, p.area_name
      from public.phoenix_crm_places p
      where p.customer_id = c.id
        and p.status = 'active'
        and (p_include_test or not p.is_test)
      order by p.captured_at asc, p.id asc
      limit 1
    ) place on true
    where c.seat_id = any (p_seat_ids)
      and (p_include_test or not c.is_test)
      and c.validated_at is not null
      and c.status = 'active'
  ),
  window_visits as (
    select v.customer_id, count(*)::integer as visits
    from public.phoenix_crm_countable_visits v
    where v.seat_id = any (p_seat_ids)
      and v.visit_date >= p_from
      and v.visit_date <= p_to
      and (p_include_test or not v.is_test)
    group by v.customer_id
  ),
  scored as (
    select l.seat_id, l.brick_id, l.brick_name, l.area_code, l.area_name, l.list_type,
           coalesce(wv.visits, 0) as visits
    from listed l
    left join window_visits wv on wv.customer_id = l.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.seat_id, r.area_code nulls last, r.brick_name nulls last), '[]'::jsonb)
  from (
    select
      s.seat_id,
      s.brick_id,
      s.brick_name,
      s.area_code,
      s.area_name,
      count(*)::integer as customers,
      (count(*) filter (where s.list_type = 'AM'))::integer as am,
      (count(*) filter (where s.list_type = 'PM'))::integer as pm,
      (count(*) filter (where s.visits > 0))::integer as visited,
      (count(*) filter (where s.list_type = 'AM' and s.visits > 0))::integer as am_visited,
      (count(*) filter (where s.list_type = 'PM' and s.visits > 0))::integer as pm_visited,
      coalesce(sum(s.visits), 0)::integer as visits
    from scored s
    group by s.seat_id, s.brick_id, s.brick_name, s.area_code, s.area_name
  ) r;
$$;

revoke execute on function public.phoenix_crm_report_brick_coverage(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_brick_coverage(text[], date, date, boolean) to service_role;

notify pgrst, 'reload schema';

commit;

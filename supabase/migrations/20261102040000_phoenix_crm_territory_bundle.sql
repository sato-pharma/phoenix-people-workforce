-- Two Phoenix CRM territory reads in ONE statement each: phoenix_crm_territory_customers(...) and
-- phoenix_crm_planned_day(...).
--
-- WHY (owner, 1 Nov 2026: "find the ROOT root cause of the slowness"). Each read costs about 450 ms at
-- Supabase's edge for 2-7 ms of SQL on the saturated 2-core host (measured 1 Nov 2026, 10:30-11:00 Cairo:
-- 36,104 requests in half an hour), so the number of requests is the lever, not the statements. The
-- territory's customer list (loadTerritoryCustomers, src/lib/phoenix-crm/server/list.ts) was three
-- requests in two waves — the customers and their active places side by side, then the buildings those
-- places are seated in — and the week planner, the month board and the plan save each read the venue
-- NAMES again (loadSharedPlaceNames) for the same buildings. The call prep (call-prep.ts) stood its stops
-- on FIVE waves: the week's plan row, then its items and the day's facts (the edit requests and the
-- return events, two more reads), then the customers and places, then the venues, and only then the
-- iReports360 history. On the one host every wave waits ~450 ms before a byte is parsed.
--
-- WHAT EACH RETURNS. One jsonb object, never a set, because PostgREST's 1,000-row cap applies to a
-- set-returning function too (phx_crm_contact_roster, 25 Oct 2026, is the precedent):
--   phoenix_crm_territory_customers(p_seat_id, p_is_test, p_statuses, p_customer_ids)
--     {customers: [every column of the customer row], places: [every column of the active place row,
--      the two whole checks replaced by signboard_retake = signboard_check->retake], venues: [{id, name,
--      kind, schedule_photo_path, status}]} — the seat's customers that are no "Campaign visit N" holder
--     (20261029212200), narrowed to p_statuses when given (the List's active and pending) and to
--     p_customer_ids when given (a day's planned stops); their active places; the buildings those places
--     sit in. Customers and places in id order, the keyset walk's own order, so nothing on the screens
--     moves.
--   phoenix_crm_planned_day(p_seat_id, p_is_test, p_week_start, p_day)
--     {plan: {id, status, version, returned_day, decided_at} or null, items: [customer_id] of the day,
--      edits: [every column of the week's edit requests, with plan: {status, version}] newest first,
--      returns: [{plan_id, from_status}] of the week's 'returned' events newest first (created_at, then
--      id), stops: phoenix_crm_territory_customers(seat, test, {active, pending}, the items' ids)} —
--     the stops are read only when the week is past draft; a draft or missing week reads nobody, as the
--     call prep showed nobody. The DAY's status is still the TypeScript rule (plan-rules.ts
--     planDayStatus, fed by plan-day-status.ts loadPlanDayFacts): this function hands it the rows, it
--     decides nothing.
--
-- NO FIGURE CHANGES: the same filters, the same columns, the same rows; the TypeScript folds
-- (foldTerritoryCustomers in list.ts, loadPlannedDay in visits.ts) are pinned by
-- tests/phoenix-crm-territory-bundle.test.ts. SECURITY DEFINER (search_path 'public'), executable by
-- the service role only, as the reads were. Until it is applied each caller falls back to its reads
-- (PGRST202), so a branch deploys before its database moves.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_planned_day(text, boolean, date, date);
--   drop function if exists public.phoenix_crm_territory_customers(text, boolean, text[], uuid[]);

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_territory_customers(p_seat_id text, p_is_test boolean, p_statuses text[] default null, p_customer_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with customers as (
    select c.*
    from public.phoenix_crm_customers c
    where c.seat_id = p_seat_id
      and c.is_test = p_is_test
      and c.campaign_visit_holder = false
      and (p_statuses is null or c.status = any(p_statuses))
      and (p_customer_ids is null or c.id = any(p_customer_ids))
  ),
  places as (
    select p.*
    from public.phoenix_crm_places p
    where p.seat_id = p_seat_id
      and p.is_test = p_is_test
      and p.status = 'active'
      and (p_customer_ids is null or p.customer_id = any(p_customer_ids))
  ),
  venues as (
    select v.id, v.name, v.kind, v.schedule_photo_path, v.status
    from public.phoenix_crm_shared_places v
    where v.id in (select distinct p.shared_place_id from places p where p.shared_place_id is not null)
  )
  select jsonb_build_object(
    'customers', coalesce((select jsonb_agg(to_jsonb(c.*) order by c.id) from customers c), '[]'::jsonb),
    'places', coalesce(
      (select jsonb_agg(
         ((to_jsonb(p.*) - 'signboard_check' - 'schedule_check') || jsonb_build_object('signboard_retake', p.signboard_check -> 'retake'))
         order by p.id
       ) from places p),
      '[]'::jsonb
    ),
    'venues', coalesce((select jsonb_agg(to_jsonb(v.*) order by v.id) from venues v), '[]'::jsonb)
  );
$$;

revoke execute on function public.phoenix_crm_territory_customers(text, boolean, text[], uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_territory_customers(text, boolean, text[], uuid[]) to service_role;

create or replace function public.phoenix_crm_planned_day(p_seat_id text, p_is_test boolean, p_week_start date, p_day date)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with plan as (
    select pl.id, pl.status, pl.version, pl.returned_day, pl.decided_at
    from public.phoenix_crm_plans pl
    where pl.seat_id = p_seat_id
      and pl.is_test = p_is_test
      and pl.week_start = p_week_start
    limit 1
  ),
  items as (
    select i.id, i.customer_id
    from public.phoenix_crm_plan_items i
    join plan pl on pl.id = i.plan_id
    where i.plan_date = p_day
  ),
  edits as (
    select e.*, pl.status as plan_status, pl.version as plan_version
    from public.phoenix_crm_plan_edit_requests e
    join plan pl on pl.id = e.plan_id
    where e.is_test = p_is_test
  ),
  return_events as (
    select ev.id, ev.plan_id, ev.from_status, ev.created_at
    from public.phoenix_crm_plan_events ev
    join plan pl on pl.id = ev.plan_id
    where ev.event_type = 'returned'
  )
  select jsonb_build_object(
    'plan', (select to_jsonb(pl.*) from plan pl),
    'items', coalesce((select jsonb_agg(i.customer_id order by i.id) from items i), '[]'::jsonb),
    'edits', coalesce(
      (select jsonb_agg(
         ((to_jsonb(e.*) - 'plan_status' - 'plan_version') || jsonb_build_object('plan', jsonb_build_object('status', e.plan_status, 'version', e.plan_version)))
         order by e.created_at desc, e.id desc
       ) from edits e),
      '[]'::jsonb
    ),
    'returns', coalesce(
      (select jsonb_agg(jsonb_build_object('plan_id', r.plan_id, 'from_status', r.from_status) order by r.created_at desc, r.id desc) from return_events r),
      '[]'::jsonb
    ),
    'stops', case
      when exists (select 1 from plan pl where pl.status <> 'draft')
        then public.phoenix_crm_territory_customers(
          p_seat_id,
          p_is_test,
          array['active', 'pending'],
          coalesce((select array_agg(i.customer_id) from items i), '{}'::uuid[])
        )
      else jsonb_build_object('customers', '[]'::jsonb, 'places', '[]'::jsonb, 'venues', '[]'::jsonb)
    end
  );
$$;

revoke execute on function public.phoenix_crm_planned_day(text, boolean, date, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_planned_day(text, boolean, date, date) to service_role;

notify pgrst, 'reload schema';

commit;

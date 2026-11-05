-- phoenix_crm_customer_last_visits(p_seat_ids, p_is_test, p_since, p_hr_id): the last visit to every customer
-- of a manager's reps' territories, with its day and its clock, in ONE statement.
--
-- WHY (owner, 2026-11-05): "make a toggle … show the timing, the day and time of the last visit that was done
-- to this customer or this doctor … at the district manager, you will show either this visit was done for him
-- or no, and for the rep and its timing". With the toggle on, a manager's plan board shows on each customer
-- the days and hours the rep saved when he validated the place, the rep's last visit (day and time) and
-- whether the manager was on it, and the manager's own last visit. A PostgREST read cannot ask "the newest row
-- per customer", so the area's whole twenty-six weeks of visits would be paged through, 1,000 rows a request,
-- on the saturated host where every request costs ~450 ms (20261102040000's measurement) — one function, one
-- request.
--
-- WHAT IT RETURNS. One jsonb object, never a set (PostgREST's 1,000-row cap applies to a set-returning function
-- too — phx_crm_contact_roster is the precedent):
--   latest:      per customer, the newest visit on phoenix_crm_countable_visits_with_history since p_since
--                (the view the plan board's month marks already read), with its people and its companions.
--   with_person: per customer, the THREE newest of those visits that name p_hr_id anywhere — a fixed place
--                (manager, senior, product manager) or the companions list. A loose candidate set only: the
--                TypeScript rule `countsAsPlannersVisitWithRep` decides whether each one counts as his visit
--                with the rep, so no rule is written twice; three is room for a candidate the rule refuses.
--   hours:       every active place of those territories that carries days and hours (`timings`).
-- An imported iReports360 copy carries `imported` true: it has no clock of its own, and the screen says the
-- day alone.
--
-- HIS OWN SINGLE VISITS ARE NOT READ HERE: they count in his own report only and never reach a view or a
-- database function (tests/phoenix-crm-manager-plan-source.test.ts), so the TypeScript reads his few rows.
--
-- READS ONLY. SECURITY DEFINER (search_path 'public'), executable by the service role only, as the reads it
-- replaces were. The caller (server/manager-visit-times.ts) gates the seats exactly as the month marks do.
-- Applied to staging and production before the screen that calls it ships.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_customer_last_visits(text[], boolean, date, text);

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_customer_last_visits(p_seat_ids text[], p_is_test boolean, p_since date, p_hr_id text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with person as (
    select upper(regexp_replace(coalesce(p_hr_id, ''), '[^A-Za-z0-9]', '', 'g')) as key
  ),
  visits as materialized (
    select v.id, v.customer_id, v.visit_date, v.captured_at, v.kind, v.rep_hr_id, v.manager_hr_id, v.senior_hr_id,
           v.product_manager_hr_id, v.imported_from_ireports360_at is not null as imported
    from public.phoenix_crm_countable_visits_with_history v
    where v.seat_id = any (p_seat_ids)
      and v.is_test = p_is_test
      and v.visit_date >= p_since
      and v.customer_id is not null
  ),
  companions as (
    select c.visit_id, array_agg(c.hr_id order by c.position) as hr_ids
    from public.phoenix_crm_visit_companions c
    where c.visit_id in (select id from visits)
    group by c.visit_id
  ),
  latest as (
    select distinct on (v.customer_id) v.*
    from visits v
    order by v.customer_id, v.visit_date desc, v.captured_at desc nulls last, v.id desc
  ),
  named as (
    select v.*, row_number() over (partition by v.customer_id order by v.visit_date desc, v.captured_at desc nulls last, v.id desc) as rank
    from visits v
    left join companions c on c.visit_id = v.id
    cross join person p
    where p.key <> ''
      and (
        upper(regexp_replace(coalesce(v.manager_hr_id, ''), '[^A-Za-z0-9]', '', 'g')) = p.key
        or upper(regexp_replace(coalesce(v.senior_hr_id, ''), '[^A-Za-z0-9]', '', 'g')) = p.key
        or upper(regexp_replace(coalesce(v.product_manager_hr_id, ''), '[^A-Za-z0-9]', '', 'g')) = p.key
        or exists (select 1 from unnest(c.hr_ids) as h(hr_id) where upper(regexp_replace(coalesce(h.hr_id, ''), '[^A-Za-z0-9]', '', 'g')) = p.key)
      )
  )
  select jsonb_build_object(
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', l.customer_id, 'visit_id', l.id, 'visit_date', l.visit_date, 'captured_at', l.captured_at,
        'imported', l.imported, 'kind', l.kind, 'rep_hr_id', l.rep_hr_id, 'manager_hr_id', l.manager_hr_id,
        'senior_hr_id', l.senior_hr_id, 'product_manager_hr_id', l.product_manager_hr_id,
        'companion_hr_ids', coalesce(to_jsonb(c.hr_ids), '[]'::jsonb)
      ) order by l.customer_id)
      from latest l
      left join companions c on c.visit_id = l.id
    ), '[]'::jsonb),
    'with_person', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', n.customer_id, 'visit_id', n.id, 'visit_date', n.visit_date, 'captured_at', n.captured_at,
        'imported', n.imported, 'kind', n.kind, 'rep_hr_id', n.rep_hr_id, 'manager_hr_id', n.manager_hr_id,
        'senior_hr_id', n.senior_hr_id, 'product_manager_hr_id', n.product_manager_hr_id,
        'companion_hr_ids', coalesce(to_jsonb(c.hr_ids), '[]'::jsonb)
      ) order by n.customer_id, n.rank)
      from named n
      left join companions c on c.visit_id = n.id
      where n.rank <= 3
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('customer_id', pl.customer_id, 'place_id', pl.id, 'label', pl.label, 'timings', pl.timings) order by pl.customer_id, pl.id)
      from public.phoenix_crm_places pl
      where pl.seat_id = any (p_seat_ids)
        and pl.is_test = p_is_test
        and pl.status = 'active'
        and jsonb_typeof(pl.timings) = 'array'
        and jsonb_array_length(pl.timings) > 0
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.phoenix_crm_customer_last_visits(text[], boolean, date, text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_last_visits(text[], boolean, date, text) to service_role;

commit;

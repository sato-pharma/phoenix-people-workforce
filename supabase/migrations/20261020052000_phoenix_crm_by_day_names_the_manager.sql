-- phoenix_crm_by_day_names_the_manager
--
-- WHAT THIS CHANGES:
--   public.phoenix_crm_report_visits_by_day returns one more key on every row, manager_hr_id: the manager
--   who made the visit ON HIS OWN, and null on every other row. Rows are now grouped by that key as well,
--   so two managers' own visits on one territory on one day are two rows, no longer one.
--   Same signature, same return type (jsonb), same grants. No table, view or row is touched.
--
-- WHY:
--   Owner, 2026-10-20 ("every single role that is applicable to appear in a module — find it and show
--   it"): the Reports tab's Visits report printed every manager's own single visits as one line,
--   "Managers' own visits", per territory. A district manager's visits and his national sales manager's
--   visits on the same territory read as one anonymous figure. A manager's own visit is a visit with no
--   rep (rep_hr_id is null) and the manager on it (manager_hr_id) — 25 of 3,685 countable visits since
--   1 September 2026 — so the name was in the table all along; the function just did not return it.
--
--   The key is filled ONLY where rep_hr_id is null. A ride-along (a double or chain visit) also carries
--   manager_hr_id, but its figure belongs to the rep it was made with; naming the manager there would
--   split the rep's own row in two and change every rep figure on the screen. A rep's row is therefore
--   byte-identical to what it was.
--
--   Everything else is byte-identical to 20261016161248, block 5: the countable view, the validated-
--   customer join, the waiting count and the order.
--
-- ROLLBACK:
--   Re-run block 5 of 20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql. The
--   screen reads the new key as optional, so rolling back only puts the managers back on one line.

create or replace function public.phoenix_crm_report_visits_by_day(
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
  with counted as (
    select
      v.seat_id,
      v.rep_hr_id,
      -- Only a visit no rep was on names its manager; a ride-along stays on the rep's row.
      (case when v.rep_hr_id is null then v.manager_hr_id end) as manager_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as visits,
      (count(*) filter (where v.kind = 'double'))::integer as double_visits,
      (count(*) filter (where v.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where v.location_flag = 'far'))::integer as far_visits,
      (count(*) filter (where v.is_test))::integer as test_visits
    -- The countable view, never the base table: an off-plan visit counts in nothing until the manager
    -- and then the SFE have approved it, and a recorded visit until the Administrator has.
    from public.phoenix_crm_countable_visits v
    -- A visit counts only once its customer is validated; then every earlier one counts too.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, (case when v.rep_hr_id is null then v.manager_hr_id end), v.visit_date, v.list_type
  ),
  -- Beside the count, not inside it: a day whose figure is low because three visits are waiting for a
  -- decision must say so, or the dip reads as a rep who did not work.
  waiting as (
    select
      v.seat_id,
      v.rep_hr_id,
      (case when v.rep_hr_id is null then v.manager_hr_id end) as manager_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as unplanned_waiting
    from public.phoenix_crm_visits v
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
    left join public.phoenix_crm_visit_recordings r on r.visit_id = v.id
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
      and (
        u.status in ('admin_pending', 'manager_pending', 'sfe_pending')
        or (r.review_status = 'pending' and (u.status is null or u.status <> 'refused'))
      )
    group by v.seat_id, v.rep_hr_id, (case when v.rep_hr_id is null then v.manager_hr_id end), v.visit_date, v.list_type
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.visit_date, t.list_type, t.rep_hr_id, t.manager_hr_id), '[]'::jsonb)
  from (
    select
      coalesce(c.seat_id, w.seat_id) as seat_id,
      coalesce(c.rep_hr_id, w.rep_hr_id) as rep_hr_id,
      coalesce(c.manager_hr_id, w.manager_hr_id) as manager_hr_id,
      coalesce(c.visit_date, w.visit_date) as visit_date,
      coalesce(c.list_type, w.list_type) as list_type,
      coalesce(c.visits, 0) as visits,
      coalesce(c.double_visits, 0) as double_visits,
      coalesce(c.chain_visits, 0) as chain_visits,
      coalesce(c.far_visits, 0) as far_visits,
      coalesce(c.test_visits, 0) as test_visits,
      coalesce(w.unplanned_waiting, 0) as unplanned_waiting
    from counted c
    full join waiting w
      on w.seat_id = c.seat_id
     and w.visit_date = c.visit_date
     and w.list_type = c.list_type
     and w.rep_hr_id is not distinct from c.rep_hr_id
     and w.manager_hr_id is not distinct from c.manager_hr_id
  ) t;
$$;

revoke execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) to service_role;

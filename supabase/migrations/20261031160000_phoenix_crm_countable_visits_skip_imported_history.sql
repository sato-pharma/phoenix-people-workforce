-- WHAT: public.phoenix_crm_countable_visits stops returning a visit copied from iReports360 history, at
--   its root, and the history screens read a new view that keeps it.
--   1. public.phoenix_crm_countable_visits_with_history — the countable view as 20261029212200 left it,
--      byte for byte in its select: every countable visit, copied history included. Service role only.
--   2. public.phoenix_crm_countable_visits gains `and v.imported_from_ireports360_at is null`. Same
--      columns in the same order, so its dependents (crm_visits_unified, crm_checkins_unified) stand.
--   3. The four report functions that show history — brick coverage, coverage, manager visits, visits by
--      day — read the history view. Their live production bodies, with only the view's name changed.
--   Every other reader of the countable view now skips the copy without being told to:
--   phoenix_crm_rep_entry_days_calc and the two unified doors already started at the team's Phoenix
--   start date, which no copied visit reaches, so their rows do not change; phoenix_crm_seat_visit_firsts
--   (the adoption board) stops reading a copied January visit as the seat's first Phoenix visit.
-- WHY: the import (20261029212200) left the copy in the countable view and asked every reader that judges,
--   alarms or pays to skip it by the mark. A new reader that forgot the mark would have counted ~69,000
--   copied visits as Phoenix work. Skipping is now the default, and counting the history is the reader
--   that has to ask for it by name. Account: docs/phoenix-crm-ireports360-history-import.md.
-- ROLLBACK: re-create public.phoenix_crm_countable_visits from 20261029212200 (no import filter); re-create
--   the four functions from 20260927003000 (brick coverage), 20260926163000 (coverage), 20261007111250
--   (manager visits) and 20261020052000 (visits by day) — the live bodies differ from those files only in
--   naming the countable view — and then
--     drop view public.phoenix_crm_countable_visits_with_history;
--   Nothing is written to any row.

begin;
set local lock_timeout = '5s';

-- 1. The history view -----------------------------------------------------------------------------------

create or replace view public.phoenix_crm_countable_visits_with_history
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    v.product_manager_hr_id,
    -- Kept, so a history reader can still tell a copied visit from one entered in Phoenix.
    v.imported_from_ireports360_at
  from public.phoenix_crm_visits v
  -- LEFT for the same reason as the countable view below: never "fix" it back to inner.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    );

comment on view public.phoenix_crm_countable_visits_with_history is
  'Every countable Phoenix CRM visit, iReports360 history copied by 20261029212200 included. For the screens that show a rep''s whole year (timeline, Visit Report, Frequency, calendar reports). Anything that judges, alarms or pays reads phoenix_crm_countable_visits, which skips the copy.';

revoke all on table public.phoenix_crm_countable_visits_with_history from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits_with_history to service_role;

-- 2. The countable view skips the copy ------------------------------------------------------------------
--
-- 20261029212200's body, byte for byte, with the import filter added last. CREATE OR REPLACE VIEW keeps its
-- comment and its dependents.
create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does. Coalesced so the
    -- column stays two-state although the join below is a left one.
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id,
    -- Appended (20261029212200), last for the same reason. Always null here since 20261031160000 — the
    -- filter below removes every copied visit — and kept because a view cannot lose a column.
    v.imported_from_ireports360_at
  from public.phoenix_crm_visits v
  -- LEFT, so the planner drops this join for every reader that never asks for customer_validated
  -- (phoenix_crm_rep_entry_days above all). It can never null-extend: customer_id is NOT NULL and
  -- carries the foreign key. Never "fix" it back to inner — that restores a customer lookup per visit.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      -- 🔴 AN IN, NOT A LEFT JOIN (speed, 2026-10-28). The join probed the off-plan table's primary key
      -- once for EVERY visit any reader walked — about 12 million probes — to read one column. The IN is
      -- one hash of the approved rows per read. Exact: visit_id is that table's primary key, so the list
      -- holds no NULL and at most one row per visit. Never "fix" it back to a join.
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    -- 🔴 A visit copied from iReports360 history is not Phoenix work (20261031160000). Every reader that
    -- judges, alarms or pays reads this view, so it skips the copy here, once. A screen that shows the
    -- rep's whole year reads phoenix_crm_countable_visits_with_history instead.
    and v.imported_from_ireports360_at is null;

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- 3. The report functions that show history read the history view ---------------------------------------
--
-- Each is its live production definition (pg_get_functiondef, 2026-10-31) with only the view's name
-- changed. Same signatures, same return type, same grants.

create or replace function public.phoenix_crm_report_brick_coverage(p_seat_ids text[], p_from date, p_to date, p_include_test boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with listed as (
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
    from public.phoenix_crm_countable_visits_with_history v
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

create or replace function public.phoenix_crm_report_coverage(p_seat_ids text[], p_month_start date, p_include_test boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as next_month
  ),
  targets as (
    select s.grade_targets from public.phoenix_crm_settings s where s.id = 1
  ),
  listed as (
    select c.id, c.seat_id, c.list_type, c.grade
    from public.phoenix_crm_customers c
    cross join bounds b
    where c.seat_id = any (p_seat_ids)
      and (p_include_test or not c.is_test)
      and c.validated_at is not null
      and (c.status = 'active' or c.status_changed_at >= (b.month_start::timestamp at time zone 'Africa/Cairo'))
  ),
  month_visits as (
    select v.customer_id, count(*)::integer as visits
    from public.phoenix_crm_countable_visits_with_history v
    cross join bounds b
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date >= b.month_start
      and v.visit_date < b.next_month
      and (p_include_test or not v.is_test)
    group by v.customer_id
  ),
  scored as (
    select
      l.seat_id,
      l.list_type,
      coalesce(mv.visits, 0) as visits,
      case when l.grade is null then null else nullif(t.grade_targets -> l.list_type ->> l.grade, '')::integer end as target
    from listed l
    left join targets t on true
    left join month_visits mv on mv.customer_id = l.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.seat_id, r.list_type), '[]'::jsonb)
  from (
    select
      s.seat_id,
      s.list_type,
      count(*)::integer as customers,
      (count(*) filter (where s.visits > 0))::integer as covered,
      (count(*) filter (where s.target is not null))::integer as with_target,
      (count(*) filter (where s.target is not null and s.visits = s.target))::integer as on_target,
      (count(*) filter (where s.target is not null and s.visits < s.target))::integer as under,
      (count(*) filter (where s.target is not null and s.visits > s.target))::integer as over,
      coalesce(sum(s.visits), 0)::integer as visits
    from scored s
    group by s.seat_id, s.list_type
  ) r;
$$;

revoke execute on function public.phoenix_crm_report_coverage(text[], date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_coverage(text[], date, boolean) to service_role;

create or replace function public.phoenix_crm_report_manager_visits(p_hr_ids text[], p_from date, p_to date, p_include_test boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.senior_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    union all
    -- The product manager, in his own column. Both kinds he can be on: 'product_manager' (the rep
    -- ticked one person under "Double visit" and it was him) and 'chain' (he was the second person on
    -- a chain). No `kind` filter is needed — product_manager_hr_id is set on those two kinds alone,
    -- and the constraint phoenix_crm_visits_participants is what guarantees it.
    select pe.hr_id, 'product_manager'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits_with_history v on v.product_manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      -- Never added into double_visits: that figure is kind = 'double' on every board and district
      -- managers are judged on it.
      (count(*) filter (where j.kind = 'product_manager'))::integer as product_manager_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$$;

revoke execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) to service_role;

create or replace function public.phoenix_crm_report_visits_by_day(p_seat_ids text[], p_from date, p_to date, p_include_test boolean default false)
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
      (case when v.rep_hr_id is null then v.manager_hr_id end) as manager_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as visits,
      (count(*) filter (where v.kind = 'double'))::integer as double_visits,
      (count(*) filter (where v.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where v.location_flag = 'far'))::integer as far_visits,
      (count(*) filter (where v.is_test))::integer as test_visits
    from public.phoenix_crm_countable_visits_with_history v
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, (case when v.rep_hr_id is null then v.manager_hr_id end), v.visit_date, v.list_type
  ),
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

notify pgrst, 'reload schema';

commit;

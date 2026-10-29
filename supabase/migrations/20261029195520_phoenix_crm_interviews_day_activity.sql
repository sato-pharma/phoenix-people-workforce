-- phoenix_crm_interviews_day_activity
--
-- WHAT THIS CHANGES: one more day kind, 'interviews', placed beside 'admin_work' (owner, 2026-10-29: "IN PHX
-- CRM ADD AN OPTION UNDER ADMIN WORK FOR INTERVIEWS" — its own choice, right after Admin work):
--   1. phoenix_crm_day_activities_type and phoenix_crm_save_day_activity — the rep's recorded day.
--   2. phoenix_crm_plan_activities_type and phoenix_crm_save_plan_activities — the rep's weekly plan.
--   3. phoenix_crm_manager_plan_slots_kind (admin branch) and phoenix_crm_save_manager_plan_slot — a
--      manager's Admin half-day.
--   4. phoenix_crm_rep_entry_days_calc — a recorded Interviews day is a worked day, exactly as Admin work is.
--   5. crm_visits_unified — a recorded Interviews day reaches the old-CRM door as Admin Work (code -20), its
--      comment beginning "Interviews", so every "did he work" reader counts it as it counts Admin work.
--
-- Every body below is the live one (md5 of prosrc compared with its source file on 2026-10-29) restated
-- with ONLY its kind list widened: save_day_activity from 20261021120000, save_plan_activities from
-- 20261021130000, the slot check from 20261025020000, save_manager_plan_slot from 20261027140000,
-- rep_entry_days_calc from 20261023091035, crm_visits_unified from 20261027185332.
--
-- No existing row changes and the entry-days cache needs no rebuild: no 'interviews' row exists yet.
--
-- ROLLBACK: re-file any 'interviews' rows (as 'admin_work'), then re-run the six source blocks named above.

begin;
set local lock_timeout = '5s';

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_day_activities drop constraint if exists phoenix_crm_day_activities_type;
alter table public.phoenix_crm_day_activities
  add constraint phoenix_crm_day_activities_type
  check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews'));

create or replace function public.phoenix_crm_save_day_activity(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(btrim(p ->> 'seat_id'), '');
  v_line text := nullif(btrim(p ->> 'line_code'), '');
  v_rep text := nullif(btrim(p ->> 'rep_hr_id'), '');
  v_actor text := nullif(btrim(p ->> 'actor_hr_id'), '');
  v_date date := nullif(p ->> 'activity_date', '')::date;
  v_type text := nullif(btrim(p ->> 'activity_type'), '');
  v_half boolean := coalesce((p ->> 'half_day')::boolean, false);
  v_note text := nullif(btrim(p ->> 'note'), '');
  v_row public.phoenix_crm_day_activities%rowtype;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
begin
  if v_seat is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:day_activity:' || v_seat || ':' || v_date::text));

  if v_type is null then
    delete from public.phoenix_crm_day_activities
    where seat_id = v_seat and activity_date = v_date and is_test = v_is_test;
    return jsonb_build_object('cleared', true);
  end if;

  if v_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  insert into public.phoenix_crm_day_activities (
    seat_id, line_code, rep_hr_id, entered_by_hr_id, activity_date, activity_type, half_day, note, is_test
  )
  values (v_seat, v_line, v_rep, v_actor, v_date, v_type, v_half, v_note, v_is_test)
  on conflict (seat_id, activity_date, is_test) do update
    set activity_type = excluded.activity_type,
        half_day = excluded.half_day,
        note = excluded.note,
        entered_by_hr_id = excluded.entered_by_hr_id,
        line_code = excluded.line_code,
        rep_hr_id = excluded.rep_hr_id,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'cleared', false,
    'id', v_row.id,
    'activity_date', v_row.activity_date,
    'activity_type', v_row.activity_type,
    'half_day', v_row.half_day,
    'note', v_row.note
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_day_activity(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_day_activity(jsonb) to service_role;

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_plan_activities drop constraint if exists phoenix_crm_plan_activities_type;
alter table public.phoenix_crm_plan_activities
  add constraint phoenix_crm_plan_activities_type
  check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews'));

-- SAFE: widening the admin branch of a CHECK by one value; every existing row already satisfies the new form.
alter table public.phoenix_crm_manager_plan_slots drop constraint if exists phoenix_crm_manager_plan_slots_kind;
alter table public.phoenix_crm_manager_plan_slots
  add constraint phoenix_crm_manager_plan_slots_kind check (
    (kind = 'with_rep' and rep_seat_id is not null and rep_hr_id is not null and activity_type is null
      and area_code is null and area_seat_id is null)
    or (kind = 'admin' and activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews', 'office')
      and rep_seat_id is null and rep_hr_id is null and area_code is null and area_seat_id is null
      and scope_dm_seat_id is null and scope_line_code is null)
    or (kind = 'single_visit' and area_code is not null and rep_seat_id is null and rep_hr_id is null and activity_type is null)
    -- A CHECK passes on NULL, so every test below is written to come out FALSE, never NULL, on a bad row.
    or (kind = 'with_dm' and scope_dm_seat_id is not null and scope_line_code is not null
      and rep_seat_id is null and rep_hr_id is null and activity_type is null and area_code is null and area_seat_id is null
      and dm_visit is not null
      and coalesce(jsonb_typeof(dm_visit), '') = 'object'
      and (case when jsonb_typeof(dm_visit -> 'areas') = 'array' then jsonb_array_length(dm_visit -> 'areas') else 0 end) between 1 and 60)
    -- A district manager's With my manager carries no scope; a regional, national or product manager's names the
    -- district manager seat and its line (owner, 2026-10-25) — both or neither.
    or (kind = 'with_senior'
      and ((scope_dm_seat_id is null and scope_line_code is null) or (scope_dm_seat_id is not null and scope_line_code is not null))
      and rep_seat_id is null and rep_hr_id is null and activity_type is null and area_code is null and area_seat_id is null
      and senior_visit is not null
      and coalesce(jsonb_typeof(senior_visit), '') = 'object'
      and coalesce(nullif(trim(senior_visit ->> 'senior_hr_id'), ''), '') <> ''
      and (case when jsonb_typeof(senior_visit -> 'areas') = 'array' then jsonb_array_length(senior_visit -> 'areas') else 0 end) between 1 and 60)
    or (kind = 'with_area' and scope_region_code is not null and area_seat_id is not null and area_code is not null
      and rep_seat_id is null and rep_hr_id is null and activity_type is null
      and scope_dm_seat_id is null and scope_line_code is null and senior_visit is null
      and dm_visit is not null
      and coalesce(jsonb_typeof(dm_visit), '') = 'object'
      and (case when jsonb_typeof(dm_visit -> 'areas') = 'array' then jsonb_array_length(dm_visit -> 'areas') else 0 end) = 1)
  );

create or replace function public.phoenix_crm_save_plan_activities(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_week date := nullif(p ->> 'week_start', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_items jsonb := coalesce(p -> 'activities', '[]'::jsonb);
  v_days date[];
  v_plan public.phoenix_crm_plans%rowtype;
  v_count integer;
begin
  if v_seat is null or v_actor is null or v_week is null
    or extract(isodow from v_week) <> 6
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_typeof(p -> 'editable_days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(distinct d.value::date), '{}'::date[])
  into v_days
  from jsonb_array_elements_text(p -> 'editable_days') d;

  if exists (select 1 from unnest(v_days) d where d < v_today or d < v_week or d > v_week + 5) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text, note text)
    where x.plan_date is null or not (x.plan_date = any (v_days))
      or x.activity_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews')
      or (x.note is not null and char_length(x.note) > 300)
  ) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan
  from public.phoenix_crm_plans pl
  where pl.seat_id = v_seat
    and pl.week_start = v_week
    and pl.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_plan.status not in ('draft', 'returned') then
    raise exception 'phoenix_crm:not_editable';
  end if;

  -- A kind the list no longer holds for its day comes off; the other kinds on that day stay.
  delete from public.phoenix_crm_plan_activities a
  where a.plan_id = v_plan.id
    and a.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text)
      where x.plan_date = a.plan_date
        and x.activity_type = a.activity_type
    );

  -- One of each kind a day: a kind sent twice for one day is kept once, never a reason to lose the plan.
  insert into public.phoenix_crm_plan_activities (plan_id, plan_date, activity_type, half_day, note)
  select distinct on (x.plan_date, x.activity_type)
    v_plan.id, x.plan_date, x.activity_type, coalesce(x.half_day, false), nullif(trim(coalesce(x.note, '')), '')
  from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text, half_day boolean, note text)
  order by x.plan_date, x.activity_type
  on conflict (plan_id, plan_date, activity_type) do update
    set half_day = excluded.half_day,
        note = excluded.note,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_activities a where a.plan_id = v_plan.id;

  return jsonb_build_object('plan_id', v_plan.id, 'activity_count', v_count);
end;
$$;

revoke execute on function public.phoenix_crm_save_plan_activities(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_plan_activities(jsonb) to service_role;

create or replace function public.phoenix_crm_save_manager_plan_slot(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_seat text := nullif(trim(coalesce(p ->> 'manager_seat_id', '')), '');
  v_planner text := coalesce(nullif(trim(coalesce(p ->> 'planner_kind', '')), ''), 'dm');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'plan_date', '')::date;
  v_half text := coalesce(p ->> 'half', '');
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_rep_seat text := nullif(trim(coalesce(p ->> 'rep_seat_id', '')), '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_activity text := nullif(trim(coalesce(p ->> 'activity_type', '')), '');
  v_area_seat text := nullif(trim(coalesce(p ->> 'area_seat_id', '')), '');
  v_area_code text := nullif(trim(coalesce(p ->> 'area_code', '')), '');
  v_area_name text := nullif(trim(coalesce(p ->> 'area_name', '')), '');
  v_scope_seat text := nullif(trim(coalesce(p ->> 'scope_dm_seat_id', '')), '');
  v_scope_line text := nullif(trim(coalesce(p ->> 'scope_line_code', '')), '');
  v_dm_visit jsonb := p -> 'dm_visit';
  v_senior_visit jsonb := p -> 'senior_visit';
  v_region text := nullif(trim(coalesce(p ->> 'scope_region_code', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_customers jsonb := coalesce(p -> 'customers', '[]'::jsonb);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_this_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_slot_id uuid;
  v_entry jsonb;
  v_cid uuid;
  v_mcid uuid;
begin
  if v_planner not in ('dm', 'rsm', 'nsm', 'pm', 'tm') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A product manager and the Training Manager hold no seat; everybody else plans from his own.
  if v_manager is null or (v_seat is null and v_planner not in ('pm', 'tm')) or v_actor is null or v_date is null or v_half not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_customers) <> 'array' or jsonb_array_length(v_customers) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A scope is the district manager seat (and its line) or a line alone; a district manager plans his
  -- own district, so his half-days carry none, and Admin never does. With a manager or product manager
  -- names the district manager seat for every planner but him (owner, 2026-10-25).
  if (v_scope_seat is not null and v_scope_line is null)
     or ((v_scope_seat is not null or v_scope_line is not null)
         and (v_planner = 'dm' or v_kind is distinct from 'with_rep' and v_kind is distinct from 'single_visit' and v_kind is distinct from 'with_dm' and v_kind is distinct from 'with_senior')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- The Training Manager (owner, 2026-10-24): a region, then a rep or an area, or Admin — never a district
  -- manager or a line, never a customer. A region belongs to her and to her two kinds alone.
  if v_planner = 'tm' then
    if v_kind is not null and v_kind not in ('with_rep', 'with_area', 'admin') then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
    if v_scope_seat is not null or v_scope_line is not null or jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if v_kind in ('with_rep', 'with_area') and v_region is null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_region is not null or v_kind = 'with_area' then
    raise exception 'phoenix_crm:manager_plan_bad_kind';
  end if;
  if v_region is not null and v_kind is distinct from 'with_rep' and v_kind is distinct from 'with_area' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Each kind carries its own fields and nothing else; a clear carries nothing.
  if v_kind is distinct from 'with_dm' and v_kind is distinct from 'with_area' and v_dm_visit is not null and jsonb_typeof(v_dm_visit) <> 'null' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind is distinct from 'with_senior' and v_senior_visit is not null and jsonb_typeof(v_senior_visit) <> 'null' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind is null then
    if jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_rep' then
    if v_rep_seat is null or v_rep is null or v_activity is not null or v_area_code is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'admin' then
    if v_activity is null or v_activity not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'interviews', 'office')
       or v_rep_seat is not null or v_area_code is not null or jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- Office belongs to the managers judged by their office days, never to a district manager's board.
    if v_activity = 'office' and v_planner = 'dm' then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
  elsif v_kind = 'single_visit' then
    if v_area_code is null or v_rep_seat is not null or v_activity is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_dm' then
    -- With a district manager (owner, 2026-10-23): the regional, national and product managers only, in a
    -- district manager's own district, on the areas he ticked, and with no customer of anyone's.
    if v_planner = 'dm' then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
    if v_scope_seat is null or v_rep_seat is not null or v_activity is not null or v_area_code is not null
       or v_area_seat is not null or jsonb_array_length(v_customers) > 0
       or coalesce(jsonb_typeof(v_dm_visit), '') <> 'object'
       or (case when jsonb_typeof(v_dm_visit -> 'areas') = 'array' then jsonb_array_length(v_dm_visit -> 'areas') else 0 end) not between 1 and 60
       or exists (
         select 1 from jsonb_array_elements(v_dm_visit -> 'areas') a
         where nullif(trim(coalesce(a.value ->> 'seat_id', '')), '') is null
       ) then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_area' then
    -- An area (owner, 2026-10-24): the Training Manager's half-day in one area of her region — its seat, code
    -- and name, and every territory of it in dm_visit so Done reads the reps' visits there without a guess.
    if v_area_seat is null or v_area_code is null or v_area_name is null or v_rep_seat is not null or v_activity is not null
       or coalesce(jsonb_typeof(v_dm_visit), '') <> 'object'
       or (case when jsonb_typeof(v_dm_visit -> 'areas') = 'array' then jsonb_array_length(v_dm_visit -> 'areas') else 0 end) <> 1
       or exists (
         select 1 from jsonb_array_elements(v_dm_visit -> 'areas') a
         where nullif(trim(coalesce(a.value ->> 'seat_id', '')), '') is distinct from v_area_seat
       ) then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_senior' then
    -- With my manager or product manager (owner, 2026-10-23): a district manager in his own district (no scope,
    -- the clause above), with one person and the areas he ticked. Since 2026-10-27 (owner: "I want to be
    -- optional … all the doctor list of this area appear, but he is not required to choose") he may also name
    -- doctors of those areas' rep lists, or none; the loop below takes rep customers only and the application
    -- keeps them inside the ticked areas. Since 2026-10-25
    -- (owner: "in weekly plan for nsm make an option to dv with product manager … same to product manager option
    -- 2 double visit with nsm") the regional, national and product managers plan it too, in one district manager's
    -- district (the scope seat is required), never the Training Manager. Who may be picked is the application's
    -- (the chain of the line and its product managers, never a product manager beside another).
    if v_planner = 'tm' then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
    if v_planner <> 'dm' and v_scope_seat is null then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if v_rep_seat is not null or v_activity is not null or v_area_code is not null
       or v_area_seat is not null
       or coalesce(jsonb_typeof(v_senior_visit), '') <> 'object'
       or nullif(trim(coalesce(v_senior_visit ->> 'senior_hr_id', '')), '') is null
       or upper(trim(v_senior_visit ->> 'senior_hr_id')) = v_manager
       or (case when jsonb_typeof(v_senior_visit -> 'areas') = 'array' then jsonb_array_length(v_senior_visit -> 'areas') else 0 end) not between 1 and 60
       or exists (
         select 1 from jsonb_array_elements(v_senior_visit -> 'areas') a
         where nullif(trim(coalesce(a.value ->> 'seat_id', '')), '') is null
       ) then
      raise exception 'phoenix_crm:bad_input';
    end if;
  else
    raise exception 'phoenix_crm:manager_plan_bad_kind';
  end if;
  -- A half-day with a rep or on a single visit names the customers he will see.
  -- The Training Manager's With a rep names the rep alone (owner, 2026-10-24: "he neevr choose dr").
  if v_kind in ('with_rep', 'single_visit') and v_planner <> 'tm' and jsonb_array_length(v_customers) = 0 then
    raise exception 'phoenix_crm:manager_plan_slot_empty';
  end if;

  -- The field week: Saturday to Wednesday, AM and PM; Thursday a morning; never a Friday.
  if extract(isodow from v_date) = 5 or (extract(isodow from v_date) = 4 and v_half = 'PM') then
    raise exception 'phoenix_crm:manager_plan_not_field_time';
  end if;
  -- A day that has passed keeps its plan, so actual against planned still reads what was planned.
  if v_date < v_today then
    raise exception 'phoenix_crm:manager_plan_day_passed';
  end if;
  -- calendar.ts fieldWeekStart in SQL. The week he is in and the coming one — the application narrows
  -- it to the one he plans (the coming week, or the week he is in while he never sent it).
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);
  v_this_week := v_today - ((extract(isodow from v_today)::integer + 1) % 7);
  if v_week not in (v_this_week, v_this_week + 7) then
    raise exception 'phoenix_crm:manager_plan_week_closed';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan
  from public.phoenix_crm_manager_plans pl
  where pl.manager_hr_id = v_manager and pl.week_start = v_week and pl.is_test = v_is_test
  for update;

  if not found then
    -- The screen showed no week, so it sends no version. Anything else means another screen made it.
    if v_expected is not null then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    if v_kind is null then
      return jsonb_build_object('plan_id', null, 'version', null, 'status', null, 'week_start', v_week, 'slot_id', null);
    end if;
    insert into public.phoenix_crm_manager_plans
      (manager_hr_id, manager_seat_id, planner_kind, line_code, week_start, status, version, due_on, created_by_hr_id, is_test)
    values
      (v_manager, v_seat, v_planner, v_line, v_week, 'draft', 1, public.phoenix_crm_week_due_on(v_week), v_actor, v_is_test)
    returning * into v_plan;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version)
    values (v_plan.id, 'created', v_actor, case when v_actor = v_manager then 'manager' else 'administrator' end, null, 'draft', v_plan.version);
  else
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    -- A sent week changes only through his ask to edit it, decided above him.
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:manager_plan_not_editable';
    end if;
    -- A week returned for ONE day changes on that day alone.
    if v_plan.status = 'returned' and v_plan.returned_day is not null and v_date <> v_plan.returned_day then
      raise exception 'phoenix_crm:manager_plan_day_not_returned';
    end if;
  end if;

  delete from public.phoenix_crm_manager_plan_slots s
  where s.plan_id = v_plan.id and s.plan_date = v_date and s.half = v_half;

  if v_kind is not null then
    insert into public.phoenix_crm_manager_plan_slots
      (plan_id, week_start, plan_date, half, kind, rep_seat_id, rep_hr_id, activity_type, area_seat_id, area_code, area_name,
       scope_dm_seat_id, scope_line_code, scope_region_code, dm_visit, senior_visit, note)
    values
      (v_plan.id, v_week, v_date, v_half, v_kind,
       case when v_kind = 'with_rep' then v_rep_seat end,
       case when v_kind = 'with_rep' then v_rep end,
       case when v_kind = 'admin' then v_activity end,
       case when v_kind in ('single_visit', 'with_area') then v_area_seat end,
       case when v_kind in ('single_visit', 'with_area') then v_area_code end,
       case when v_kind in ('single_visit', 'with_dm', 'with_senior', 'with_area') then v_area_name end,
       case when v_kind <> 'admin' then v_scope_seat end,
       case when v_kind <> 'admin' then v_scope_line end,
       case when v_kind in ('with_rep', 'with_area') then v_region end,
       case when v_kind in ('with_dm', 'with_area') then v_dm_visit end,
       case when v_kind = 'with_senior' then v_senior_visit end,
       v_note)
    returning id into v_slot_id;

    for v_entry in select value from jsonb_array_elements(v_customers) loop
      v_cid := nullif(v_entry ->> 'customer_id', '')::uuid;
      v_mcid := nullif(v_entry ->> 'manager_customer_id', '')::uuid;
      if (v_cid is null) = (v_mcid is null) then
        raise exception 'phoenix_crm:bad_input';
      end if;
      if v_cid is not null then
        select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_cid;
        if not found or v_customer.is_test <> v_is_test or v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        -- With a rep, every customer is that rep's own.
        if v_kind = 'with_rep' and v_customer.seat_id <> v_rep_seat then
          raise exception 'phoenix_crm:manager_plan_customer_not_reps';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, customer_id, source_seat_id, list_type)
        values (v_slot_id, v_cid, v_customer.seat_id, v_customer.list_type)
        on conflict do nothing;
      else
        -- His own list belongs to his single visits, and to him.
        if v_kind <> 'single_visit' then
          raise exception 'phoenix_crm:bad_input';
        end if;
        if not exists (
          select 1 from public.phoenix_crm_manager_customers m
          where m.id = v_mcid and m.manager_hr_id = v_manager and m.is_test = v_is_test and m.status <> 'removed'
        ) then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, manager_customer_id)
        values (v_slot_id, v_mcid)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  -- The week follows who plans it now: a person whose post changed between two saves of an open week
  -- plans it under his new kind and seat (a send then refuses an Office half-day left on a district
  -- manager's week).
  update public.phoenix_crm_manager_plans pl
  set version = pl.version + 1,
      planner_kind = v_planner,
      manager_seat_id = v_seat,
      line_code = coalesce(v_line, pl.line_code),
      updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'version', v_plan.version,
    'status', v_plan.status,
    'week_start', v_plan.week_start,
    'planner_kind', v_plan.planner_kind,
    'slot_id', v_slot_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) to service_role;

create or replace function public.phoenix_crm_rep_entry_days_calc(
  p_hr_key text default null,
  p_day date default null
)
 returns table(hr_key text, agent_crm_id bigint, entry_day date)
 language sql
 stable security definer rows 400
 set search_path to 'public'
as $function$
  with entries as (
    select lower(btrim(p.rep_hr_id)) as hr_key, p.visit_date as entry_day
      from public.phoenix_crm_countable_visits p
      join public.phoenix_crm_started_team_seats() team
        on team.seat_id = p.seat_id
       and p.visit_date >= team.starts_on
       and (team.stops_on is null or p.visit_date < team.stops_on)
     where not p.is_test
       and nullif(btrim(p.rep_hr_id), '') is not null
       and (p_day is null or p.visit_date = p_day)
       and (p_hr_key is null or lower(btrim(p.rep_hr_id)) = p_hr_key)
    union
    select lower(btrim(a.rep_hr_id)), a.activity_date
      from public.phoenix_crm_day_activities a
      join public.phoenix_crm_started_team_seats() team on team.seat_id = a.seat_id
      left join public.phoenix_crm_team_starts run
        on run.team_seat_id = team.team_seat_id
       and run.starts_on = team.starts_on
       and run.stops_on is not distinct from team.stops_on
     where not a.is_test
       and nullif(btrim(a.rep_hr_id), '') is not null
       and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
       and (team.stops_on is null or a.activity_date < team.stops_on)
       and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd', 'interviews')
       and (p_day is null or a.activity_date = p_day)
       and (p_hr_key is null or lower(btrim(a.rep_hr_id)) = p_hr_key)
  )
  select e.hr_key, person.agent_crm_id, e.entry_day
    from entries e
    left join lateral (
      select case when emp.crm_id ~ '^[0-9]+$' then emp.crm_id::bigint end as agent_crm_id
        from public.employees emp
       where upper(btrim(emp.hr_id)) = upper(e.hr_key)
       order by emp.hr_id
       limit 1
    ) person on true
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_calc(text, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_calc(text, date) to service_role;

create or replace view public.crm_visits_unified
  with (security_invoker = true)
as
select
  v.id,
  v.crm_visit_id,
  v.visit_date,
  v.agent_crm_id,
  -- PHOENIX NAMES THE PERSON (owner, 2026-10-22): the employee the row's hr id resolves to, with the vendor's
  -- "( territory )" kept so every board that reads the territory off this label still finds it. A row with
  -- no hr id keeps the vendor label here (see the header).
  case when agent_person.full_name_nz is not null then concat_ws(' ', agent_person.full_name_nz, substring(v.agent_name from '(\([^()]*\))\s*$')) else v.agent_name end as agent_name,
  v.agent_hr_id,
  v.double_crm_id,
  case when double_person.full_name_nz is not null then concat_ws(' ', double_person.full_name_nz, substring(v.double_name from '(\([^()]*\))\s*$')) else v.double_name end as double_name,
  v.double_hr_id,
  v.contact_crm_id,
  -- PHOENIX NAMES THE DOCTOR: his validated Phoenix customer's name and speciality, when he has one.
  coalesce(truth.name, v.contact_name) as contact_name,
  v.customer_name,
  v.comment,
  v.visit_type,
  v.visit_type_description,
  v.call_type,
  v.ampm,
  v.attendance,
  v.crm_save_date,
  v.raw_payload,
  v.synced_at,
  v.created_at,
  v.updated_at,
  v.visit_date_time,
  v.crm_region_id,
  v.crm_region_name,
  coalesce(truth.speciality, v.speciality) as speciality,
  v.crm_contact_grade,
  'ireports360'::text as source,
  v.agent_crm_id as exclusion_crm_id,
  null::boolean as phoenix_customer_validated,
  -- The second person beside the rep. The vendor shape has one partner column, so it is null on every
  -- vendor row — appended, never inserted, so nothing reading by position moves.
  null::bigint as double2_crm_id,
  null::text as double2_name,
  null::text as double2_hr_id,
  -- THE PHOENIX FIELD SET (owner, 2026-10-07: "everything, GPS and evidence included" on the admin
  -- reports). Null on every iReports360 row, because the vendor feed never carried any of it —
  -- appended, never inserted, so nothing reading by position moves. What each READER may see of the
  -- location and timing half is golden rule #1's three tiers, decided per role in TypeScript
  -- (src/lib/crm/phoenix-visit-detail.ts), never by hiding a column here.
  null::text as visit_kind,
  null::text as entered_by_hr_id,
  null::text[] as products,
  null::jsonb as samples_given,
  null::jsonb as product_availability,
  null::text as objection,
  null::text as objection_note,
  null::text as next_step,
  null::date as next_step_on,
  null::text as visit_pharmacy_name,
  null::boolean as is_unplanned,
  null::text as unplanned_kind,
  null::text as photo_path,
  null::text as voice_note_path,
  null::integer as voice_note_seconds,
  null::double precision as lat,
  null::double precision as lon,
  null::numeric as accuracy_meters,
  null::integer as distance_meters,
  null::text as location_flag,
  null::double precision as photo_lat,
  null::double precision as photo_lon,
  null::numeric as photo_accuracy_meters,
  null::integer as dwell_seconds,
  null::integer as form_open_seconds,
  null::text as capture_source,
  null::integer as offline_seconds,
  null::integer as device_skew_minutes,
  null::timestamptz as phoenix_synced_at,
  null::text[] as companion_hr_ids
from (
  -- 🔴 ONE SCAN OF THE VENDOR TABLE, NOT TWO, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-23).
  -- Two things were paid on every read. (1) The split below was two UNION ALL branches over the same
  -- table, so one read scanned ireports360_visits twice. (2) Each "Phoenix wins the day" check walked a
  -- MATERIALIZED CTE of all 542 entry days ONCE PER VENDOR ROW — a function scan carries no statistics
  -- and no index, so the planner had nothing else to use. Merged into one scan reading the cache TABLE,
  -- the checks become probes of its own PRIMARY KEY (hr_key, entry_day) and its partial
  -- (agent_crm_id, entry_day) index. Measured on production, nine interleaved runs of each shape: one
  -- day 17.0 -> 7.0 ms, a month straddling the first team start 563 -> 336 ms, every row identical.
  -- The two arms stay mutually exclusive on the SAME live bound, so no row is produced twice or lost.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and (
       -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): no rep has a Phoenix entry on a day earlier than the
       -- first team start, or than that start's earlier day_activities_from, so "Phoenix wins the day" can
       -- drop nothing there and is not asked. The bound is read live, so a team started later moves nothing.
       x.visit_date < (
         select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
           from public.phoenix_crm_team_starts t
       )
       -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP (owner, 2026-10-16): on a
       -- day he has a countable entry in Phoenix CRM his iReports360 row is dropped; on a day he has none,
       -- the vendor row counts. A district manager has no entry day (rep seats only), so he keeps both.
       or (
         -- 🔴 READ FROM THE CACHE TABLE, NOT THROUGH phoenix_crm_rep_entry_days(). The function is that
         -- table and nothing else, and phoenix_crm_rep_entry_days_calc() is still the ONLY body that
         -- COMPUTES an entry day — this reads what that body wrote. Both doors are security_invoker and
         -- are granted to postgres and service_role alone; the cache carries exactly those two grants and
         -- both roles are BYPASSRLS, so reading it directly reaches the same rows for the same readers
         -- the SECURITY DEFINER function did.
         not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where e.hr_key = lower(btrim(x.agent_hr_id))
              and e.entry_day = x.visit_date
         )
         -- A vendor row the sync could not give an hr id is still his, by his CRM id.
         and not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where nullif(btrim(x.agent_hr_id), '') is null
              and e.agent_crm_id = x.agent_crm_id
              and e.entry_day = x.visit_date
         )
       )
     )
) v
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = v.contact_crm_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a visit.
left join public.crm_person_by_hr_key_cache agent_person on agent_person.hr_key = upper(btrim(v.agent_hr_id))
left join public.crm_person_by_hr_key_cache double_person on double_person.hr_key = upper(btrim(v.double_hr_id))
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  p.visit_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  case when p.rep_hr_id is not null and partner1.crm_id ~ '^[0-9]+$' then partner1.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner1.full_name end,
  case when p.rep_hr_id is not null then coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id) end,
  -- A doctor a rep added in Phoenix CRM has no vendor id and answers to his own, so no per-doctor
  -- report drops him. 923 of 12,574 customers are in that position today.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  null::text,
  p.comment,
  0,
  'Regular Visit'::text,
  null::integer,
  p.list_type,
  null::integer,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  -- When the row reached the server — NEVER phoenix_crm_visits.synced_at, which is the offline-capture
  -- fact golden rule #1 keeps off every rep-facing read (tests/phoenix-crm-blind-half.test.ts).
  p.created_at,
  p.created_at,
  p.created_at,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::integer,
  null::text,
  customer.speciality,
  customer.grade,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  p.customer_validated,
  case when p.rep_hr_id is not null and partner2.crm_id ~ '^[0-9]+$' then partner2.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner2.full_name end,
  -- One line, like every other select item: the door's own row-shape pin reads this list a LINE at a
  -- time, so an expression wrapped over six lines counts as six columns and the two branches stop
  -- matching item for item.
  case when p.rep_hr_id is not null then case when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id) when p.product_manager_hr_id is not null then p.senior_hr_id end end,
  -- THE PHOENIX FIELD SET, in the order the columns were appended. One select item per line: the
  -- door's row-shape pin reads this list a LINE at a time.
  p.kind,
  p.entered_by_hr_id,
  p.products,
  p.samples_given,
  p.product_availability,
  p.objection,
  p.objection_note,
  p.next_step,
  p.next_step_on,
  p.pharmacy_name,
  p.is_unplanned,
  p.unplanned_kind,
  p.photo_path,
  p.voice_note_path,
  p.voice_note_seconds,
  p.lat,
  p.lon,
  p.accuracy_meters,
  p.distance_meters,
  p.location_flag,
  p.photo_lat,
  p.photo_lon,
  p.photo_accuracy_meters,
  p.dwell_seconds,
  p.form_open_seconds,
  p.capture_source,
  p.offline_seconds,
  p.device_skew_minutes,
  p.synced_at,
  -- EVERYONE who came with the rep (2026-10-27): the three fixed places and every row of
  -- phoenix_crm_visit_companions, once each, sorted. double_hr_id/double2_hr_id above stay the first two.
  case when p.rep_hr_id is not null then (select array_agg(distinct cv.hr_id order by cv.hr_id) from (select upper(btrim(h)) as hr_id from unnest(array[p.manager_hr_id, p.senior_hr_id, p.product_manager_hr_id]) as h where nullif(btrim(coalesce(h, '')), '') is not null union select c.hr_id from public.phoenix_crm_visit_companions c where c.visit_id = p.id) cv) end
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
-- LEFT, not INNER, so a read that wants none of the four columns below gets no join at all: the FK
-- on p.customer_id is NOT NULL and validated, so this cannot drop a row either way (20261024180000).
left join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a visit.
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- SLOT 1 — the first person beside the rep, in the order the rep's own form puts them: the manager who
-- rode along, else the product manager (whose visits carried nobody at all before this), else the
-- senior. Taking the product manager here is what repairs every existing reader without a new column.
left join public.crm_person_by_hr_key_cache partner1 on partner1.hr_key = upper(btrim(coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id)))
-- SLOT 2 — the chain's other person: the senior above the manager, or the product manager who came
-- with him. Never the same person as slot 1, because each column is read once.
left join public.crm_person_by_hr_key_cache partner2 on partner2.hr_key = upper(btrim(
  case
    when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id)
    when p.product_manager_hr_id is not null then p.senior_hr_id
  end
))
-- phoenix_crm_countable_visits is the module's one predicate for "this visit counts" (an off-plan visit
-- only once approved) — read, never re-typed. Its other half, customer_validated (owner, 2026-10-01), is
-- CARRIED rather than filtered: a working rep's visit to a customer he has not validated yet is still a
-- day's work for every "did he work" reader, and the call rate leaves it out of the rate by the column.
where not p.is_test
union all
select
  a.id,
  -1 - ('x' || substr(md5(a.id::text), 1, 13))::bit(52)::bigint,
  a.activity_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  a.rep_hr_id,
  null::bigint,
  null::text,
  null::text,
  null::bigint,
  null::text,
  null::text,
  -- A sales day reads as iReports360 carried one: code -7, its comment beginning "Sales day". Interviews is
  -- served as Admin Work (-20), the kind it sits beside, its comment beginning "Interviews" (owner, 2026-10-29).
  case a.activity_type
    when 'sales_day' then btrim('Sales day ' || coalesce(a.note, ''))
    when 'interviews' then btrim('Interviews ' || coalesce(a.note, ''))
    else a.note
  end,
  case a.activity_type
    when 'meeting' then -11
    when 'conference' then -1
    when 'health_day' then -15
    when 'sales_day' then -7
    when 'training' then -9
    when 'admin_work' then -20
    when 'travel' then -12
    when 'group_meeting' then -2
    when 'rtd' then -22
    when 'interviews' then -20
  end,
  case a.activity_type
    when 'meeting' then 'Meeting'
    when 'conference' then 'Conference'
    when 'health_day' then 'Health Day'
    when 'sales_day' then 'Sales day'
    when 'training' then 'Training'
    when 'admin_work' then 'Admin Work'
    when 'travel' then 'Traveling'
    when 'group_meeting' then 'Group Meeting'
    when 'rtd' then 'RTD'
    when 'interviews' then 'Admin Work'
  end,
  null::integer,
  null::text,
  null::integer,
  (a.created_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  a.created_at,
  a.created_at,
  a.updated_at,
  a.activity_date::timestamp at time zone 'UTC',
  null::integer,
  null::text,
  null::text,
  null::text,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  null::boolean,
  null::bigint,
  null::text,
  null::text,
  null::text,
  null::text,
  null::text[],
  null::jsonb,
  null::jsonb,
  null::text,
  null::text,
  null::text,
  null::date,
  null::text,
  null::boolean,
  null::text,
  null::text,
  null::text,
  null::integer,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::text,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::integer,
  null::text,
  null::integer,
  null::integer,
  null::timestamptz,
  null::text[]
from public.phoenix_crm_day_activities a
join (
  select t.seat_id, t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_started_team_seats() t
  union
  -- The manager's OWN seat ("Yes, the whole team"): a district manager has no territory of his own, so
  -- a day he recorded sits on his team seat. phoenix_crm_started_team_reps counts that seat the same way.
  select s.team_seat_id, s.team_seat_id, s.starts_on, s.stops_on from public.phoenix_crm_team_starts s
) team
  on team.seat_id = a.seat_id
left join public.phoenix_crm_team_starts run
  on run.team_seat_id = team.team_seat_id
 and run.starts_on = team.starts_on
 and run.stops_on is not distinct from team.stops_on
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(a.rep_hr_id))
-- A RECORDED day activity (never a planned one), real, of a kind this branch names: a kind the module
-- adds later is left out until it is given its worked-day code here.
where not a.is_test
  -- Counted from the team's start, or from its day_activities_from when that is EARLIER (never later).
  and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
  and (team.stops_on is null or a.activity_date < team.stops_on)
  and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd', 'interviews');


notify pgrst, 'reload schema';
commit;

-- phoenix_crm_manager_plan_with_dm
--
-- WHAT THIS CHANGES: a manager's weekly plan gains a fourth half-day kind, 'with_dm' — "With a district
--   manager". A regional, national or product manager picks the district manager (the scope he already
--   picks today), then ticks one or more of that district manager's areas, vacant ones included.
--   1. phoenix_crm_manager_plan_slots gains dm_visit jsonb, the 'with_dm' half-day's own content:
--        { "dm_hr_id": "<the district manager, or null for a vacant seat>",
--          "areas": [ { "seat_id", "area_code", "area_name", "seat_ids": [every territory of that area] } ] }
--      area_name on the row holds the ticked areas' names joined, so every screen that already prints a
--      half-day's area reads them without a change.
--   2. phoenix_crm_manager_plan_slots_kind admits 'with_dm' (a scope with a district manager seat, one to
--      sixty areas, no rep, no activity, no area code); phoenix_crm_manager_plan_slots_dm_visit keeps
--      dm_visit on 'with_dm' rows only.
--   3. phoenix_crm_save_manager_plan_slot accepts 'with_dm' — never from a district manager, never with a
--      customer, never on a whole-line scope. Nothing else in the function changes: the body is
--      20261021130000 word for word plus the 'with_dm' branch, its scope clause and its two columns.
--
-- WHY (owner, 2026-10-23): "in NSM weekly plan on Phx CRM add an option for him to visit with DM … he chooses
--   one, then all his areas including vacant appear", then "also GPM or PM". Asked in chat: tick one or more
--   areas; Done when a chain visit names him; the NSM, RSM, GPM and PM all get it, the district manager not.
--   Done is judged in the application (manager-plan-report.ts), never stored here.
--
-- SAFE: adds a nullable column and widens a CHECK; all 222 slot rows on production (2026-10-23) have
--   dm_visit null and a kind the old branches already accept, so every one satisfies both new checks.
--
-- ROLLBACK: delete from public.phoenix_crm_manager_plan_slots where kind = 'with_dm'; restore
--   phoenix_crm_manager_plan_slots_kind and phoenix_crm_save_manager_plan_slot from 20261021130000; drop the
--   constraint phoenix_crm_manager_plan_slots_dm_visit and the column dm_visit.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_manager_plan_slots
  add column if not exists dm_visit jsonb;

comment on column public.phoenix_crm_manager_plan_slots.dm_visit is
  'A with_dm half-day only: {dm_hr_id, areas: [{seat_id, area_code, area_name, seat_ids}]} — the district manager he goes with and the areas he ticked (owner, 2026-10-23).';

alter table public.phoenix_crm_manager_plan_slots drop constraint if exists phoenix_crm_manager_plan_slots_kind;
alter table public.phoenix_crm_manager_plan_slots
  add constraint phoenix_crm_manager_plan_slots_kind check (
    (kind = 'with_rep' and rep_seat_id is not null and rep_hr_id is not null and activity_type is null
      and area_code is null and area_seat_id is null)
    or (kind = 'admin' and activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'office')
      and rep_seat_id is null and rep_hr_id is null and area_code is null and area_seat_id is null
      and scope_dm_seat_id is null and scope_line_code is null)
    or (kind = 'single_visit' and area_code is not null and rep_seat_id is null and rep_hr_id is null and activity_type is null)
    -- A CHECK passes on NULL, so every test below is written to come out FALSE, never NULL, on a bad row.
    or (kind = 'with_dm' and scope_dm_seat_id is not null and scope_line_code is not null
      and rep_seat_id is null and rep_hr_id is null and activity_type is null and area_code is null and area_seat_id is null
      and dm_visit is not null
      and coalesce(jsonb_typeof(dm_visit), '') = 'object'
      and (case when jsonb_typeof(dm_visit -> 'areas') = 'array' then jsonb_array_length(dm_visit -> 'areas') else 0 end) between 1 and 60)
  );

alter table public.phoenix_crm_manager_plan_slots drop constraint if exists phoenix_crm_manager_plan_slots_dm_visit;
alter table public.phoenix_crm_manager_plan_slots
  add constraint phoenix_crm_manager_plan_slots_dm_visit check (dm_visit is null or kind = 'with_dm');

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
  if v_planner not in ('dm', 'rsm', 'nsm', 'pm') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A product manager holds no seat; everybody else plans from his own.
  if v_manager is null or (v_seat is null and v_planner <> 'pm') or v_actor is null or v_date is null or v_half not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_customers) <> 'array' or jsonb_array_length(v_customers) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A scope is the district manager seat (and its line) or a line alone; a district manager plans his
  -- own district, so his half-days carry none, and Admin never does.
  if (v_scope_seat is not null and v_scope_line is null)
     or ((v_scope_seat is not null or v_scope_line is not null)
         and (v_planner = 'dm' or v_kind is distinct from 'with_rep' and v_kind is distinct from 'single_visit' and v_kind is distinct from 'with_dm')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Each kind carries its own fields and nothing else; a clear carries nothing.
  if v_kind is distinct from 'with_dm' and v_dm_visit is not null and jsonb_typeof(v_dm_visit) <> 'null' then
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
    if v_activity is null or v_activity not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting', 'office')
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
  else
    raise exception 'phoenix_crm:manager_plan_bad_kind';
  end if;
  -- A half-day with a rep or on a single visit names the customers he will see.
  if v_kind in ('with_rep', 'single_visit') and jsonb_array_length(v_customers) = 0 then
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
       scope_dm_seat_id, scope_line_code, dm_visit, note)
    values
      (v_plan.id, v_week, v_date, v_half, v_kind,
       case when v_kind = 'with_rep' then v_rep_seat end,
       case when v_kind = 'with_rep' then v_rep end,
       case when v_kind = 'admin' then v_activity end,
       case when v_kind = 'single_visit' then v_area_seat end,
       case when v_kind = 'single_visit' then v_area_code end,
       case when v_kind in ('single_visit', 'with_dm') then v_area_name end,
       case when v_kind <> 'admin' then v_scope_seat end,
       case when v_kind <> 'admin' then v_scope_line end,
       case when v_kind = 'with_dm' then v_dm_visit end,
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

commit;

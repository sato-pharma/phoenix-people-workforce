-- phoenix_crm_manager_plan_with_senior_doctors
--
-- WHAT THIS CHANGES: the half-day "With my manager or product manager" (kind 'with_senior') may name doctors.
--   phoenix_crm_save_manager_plan_slot no longer refuses customers on it; they are stored like any half-day's,
--   in phoenix_crm_manager_plan_customers, and the existing customer loop still takes rep-list customers only
--   (his own list stays a single visit's). Naming none stays valid: the doctors are optional. The body is
--   20261025020000 word for word (md5 21565d063301074025b3b321fe13d610, read live on staging and production on
--   2026-10-27) less one condition in the 'with_senior' branch, with that branch's comment updated.
--
-- WHY (owner, 2026-10-27): "when he chooses, for example, the area, all the doctor list of this area appear, but
--   he is not required to choose. He may choose or he may press the next" — "and of course if he chose the drs
--   when he submitting the visits he found his today planned drs".
--
-- SAFE: widens one branch of one function. No table, constraint, grant or row changes; every existing
--   'with_senior' half-day has no customers, which both versions accept.
--
-- ROLLBACK: delete from public.phoenix_crm_manager_plan_customers c using public.phoenix_crm_manager_plan_slots s
--   where c.slot_id = s.id and s.kind = 'with_senior'; then restore phoenix_crm_save_manager_plan_slot from
--   20261025020000.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;
set local lock_timeout = '5s';

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

commit;

-- READBACK (reads only):
--   select md5(prosrc), prosecdef from pg_proc where proname = 'phoenix_crm_save_manager_plan_slot';

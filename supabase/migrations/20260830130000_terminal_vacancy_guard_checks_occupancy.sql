-- Terminal employee vacancy guard: never reopen a seat someone already holds.
--
-- Bug, confirmed live in production before this migration: `phx_ensure_terminal_employee_vacancy`
-- fires whenever an employee's row is edited to resigned/terminated/inactive, and opens (or
-- relinks) an OPEN vacancy for that departing employee's area_id/line_id/position_id/manager_hr_id
-- footprint. It never checked whether an ACTIVE employee already occupies that exact footprint —
-- i.e. whether the seat was backfilled before the resignation/termination was entered into the
-- system, which happens routinely here since a leaver's paperwork often lags the actual handover.
--
-- Three real open vacancies were auto-opened this way and are, right now, offered to recruiters in
-- the screening/recruitment send-to-manager picker as available seats that are not available:
--
--   356  Delta (2) / Pedia / District Sales Manager   -> PD-0010 (Ahmed Elsayed Ahmed), hired 2026-08-01
--   358  Upper Egypt / Anti Infective / DSM           -> AI-0013 (Weaam Mahmoud Mohamed), hired 2026-08-24
--   360  Egypt / Anti Infective / National Sales Mgr  -> AI-0008 (Magdy El Senosey), hired 2026-08-09
--
-- Note on the match: the guard below matches on area_id + line_id + position_id, deliberately
-- WITHOUT manager_hr_id. Vacancy 358's manager_hr_id ('AA') no longer matches its occupant's real
-- manager ('AI-0008') -- manager_hr_id drifts on reorg and would have silently missed this exact
-- case had it been included, confirmed by testing the match with and without it against every open
-- vacancy in production: with manager_hr_id, only 2 of the 3 known-bad rows matched; without it,
-- all 3 did, and the match set was still exactly those 3 -- so dropping it does not introduce noise.
--
-- Guarded on "area_id is not null or position_id is not null" so a genuinely footprint-less
-- terminal employee (no area, no position on file) can never spuriously match another such row.

begin;

create or replace function public.phx_ensure_terminal_employee_vacancy(p_employee_hr_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_employee public.employees%rowtype;
  v_existing_vacancy_id bigint;
  v_manager_name text;
  v_vacancy_code text;
  v_effective_date date;
  v_blocked_reason text;
  v_occupant_hr_id text;
begin
  if nullif(trim(coalesce(p_employee_hr_id, '')), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'missing_employee_hr_id');
  end if;

  select *
  into v_employee
  from public.employees
  where hr_id = upper(trim(p_employee_hr_id));

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'employee_not_found');
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'employee_not_terminal');
  end if;

  -- NEW: is this footprint already held by someone still active? If so, the seat was backfilled
  -- before this terminal edit landed -- do not open or relink a vacancy against it.
  if v_employee.area_id is not null or v_employee.position_id is not null then
    select hr_id
    into v_occupant_hr_id
    from public.employees
    where hr_id <> v_employee.hr_id
      and lower(coalesce(employment_status, 'active')) = 'active'
      and area_id is not distinct from v_employee.area_id
      and line_id is not distinct from v_employee.line_id
      and position_id is not distinct from v_employee.position_id
    limit 1;

    if v_occupant_hr_id is not null then
      if to_regprocedure('public.phx_release_terminal_manager_ownership(text)') is not null then
        perform public.phx_release_terminal_manager_ownership(v_employee.hr_id);
      end if;

      return jsonb_build_object(
        'applied', false,
        'reason', 'seat_already_occupied',
        'employee_hr_id', v_employee.hr_id,
        'occupant_hr_id', v_occupant_hr_id
      );
    end if;
  end if;

  select full_name
  into v_manager_name
  from public.employees
  where hr_id = v_employee.manager_hr_id;

  v_effective_date := coalesce(
    v_employee.last_working_date,
    v_employee.resignation_date,
    v_employee.updated_at::date,
    v_employee.created_at::date,
    (now() at time zone 'Africa/Cairo')::date
  );

  select id
  into v_existing_vacancy_id
  from public.position_vacancies
  where lower(coalesce(status, 'open')) = 'open'
    and (
      replacement_for_hr_id = v_employee.hr_id
      or (
        nullif(trim(coalesce(replacement_for_hr_id, '')), '') is null
        and area_id is not distinct from v_employee.area_id
        and line_id is not distinct from v_employee.line_id
        and position_id is not distinct from v_employee.position_id
        and manager_hr_id is not distinct from v_employee.manager_hr_id
      )
    )
  order by
    case when replacement_for_hr_id = v_employee.hr_id then 0 else 1 end,
    created_at asc,
    id asc
  limit 1;

  if v_existing_vacancy_id is not null then
    update public.position_vacancies
    set
      area_id = v_employee.area_id,
      department_id = v_employee.department_id,
      job_title = v_employee.job_title,
      line_id = v_employee.line_id,
      manager_hr_id = v_employee.manager_hr_id,
      manager_name = v_manager_name,
      position_id = v_employee.position_id,
      region_name = v_employee.region_name,
      replacement_for_hr_id = v_employee.hr_id,
      note = case
        when coalesce(note, '') ilike '%Terminal employee vacancy guard:%' then note
        else concat_ws(
          E'\n',
          nullif(note, ''),
          'Terminal employee vacancy guard: linked open vacancy to terminal employee '
            || v_employee.hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
        )
      end,
      updated_at = now()
    where id = v_existing_vacancy_id;
  else
    v_vacancy_code := 'VAC-TERM-'
      || regexp_replace(upper(v_employee.hr_id), '[^A-Z0-9]+', '', 'g')
      || '-'
      || substr(md5(v_employee.hr_id || '|' || coalesce(v_effective_date::text, (now() at time zone 'Africa/Cairo')::date::text)), 1, 6);

    -- Opening the vacancy is BEST-EFFORT from here down. The sub-block gives it its own
    -- subtransaction, so a refusal rolls back this insert alone and never the employee edit that
    -- fired the trigger. `on conflict` covers the deterministic-code collision (A);
    -- `when unique_violation` also catches phx_guard_single_open_rep_vacancy's RAISE (B), which
    -- uses that same errcode.
    begin
      insert into public.position_vacancies (
        area_id,
        created_at,
        department_id,
        job_title,
        line_id,
        manager_hr_id,
        manager_name,
        note,
        position_id,
        region_name,
        replacement_for_hr_id,
        status,
        updated_at,
        vacancy_code
      )
      values (
        v_employee.area_id,
        now(),
        v_employee.department_id,
        v_employee.job_title,
        v_employee.line_id,
        v_employee.manager_hr_id,
        v_manager_name,
        'Terminal employee vacancy guard: auto-opened from direct lifecycle edit for '
          || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective '
          || coalesce(v_effective_date::text, (now() at time zone 'Africa/Cairo')::date::text) || '.',
        v_employee.position_id,
        v_employee.region_name,
        v_employee.hr_id,
        'open',
        now(),
        v_vacancy_code
      )
      on conflict (vacancy_code) do nothing
      returning id into v_existing_vacancy_id;
    exception
      when unique_violation then
        v_existing_vacancy_id := null;
        v_blocked_reason := 'vacancy_insert_blocked';
    end;

    if v_existing_vacancy_id is null then
      -- Nothing was opened, and that is correct in both cases:
      --   (A) the deterministic code is already held by this employee's own earlier vacancy,
      --       which a human has since cancelled or filled -- adopt it, never resurrect it;
      --   (B) the line/area already has its one permitted open medical-rep vacancy.
      -- Either way the caller's edit must still succeed.
      select id
      into v_existing_vacancy_id
      from public.position_vacancies
      where vacancy_code = v_vacancy_code;

      if v_existing_vacancy_id is not null then
        v_blocked_reason := coalesce(v_blocked_reason, 'existing_closed_vacancy');

        update public.position_vacancies
        set
          replacement_for_hr_id = coalesce(
            nullif(trim(coalesce(replacement_for_hr_id, '')), ''),
            v_employee.hr_id
          ),
          note = case
            when coalesce(note, '') ilike '%Terminal employee vacancy guard: closed vacancy%' then note
            else concat_ws(
              E'\n',
              nullif(note, ''),
              'Terminal employee vacancy guard: closed vacancy already covers terminal employee '
                || v_employee.hr_id || '; left as-is on '
                || (now() at time zone 'Africa/Cairo')::date::text || '.'
            )
          end,
          updated_at = now()
        where id = v_existing_vacancy_id;
      end if;

      if to_regprocedure('public.phx_release_terminal_manager_ownership(text)') is not null then
        perform public.phx_release_terminal_manager_ownership(v_employee.hr_id);
      end if;

      return jsonb_build_object(
        'applied', false,
        'reason', coalesce(v_blocked_reason, 'vacancy_insert_blocked'),
        'employee_hr_id', v_employee.hr_id,
        'vacancy_id', v_existing_vacancy_id,
        'vacancy_code', v_vacancy_code
      );
    end if;
  end if;

  if to_regprocedure('public.phx_release_terminal_manager_ownership(text)') is not null then
    perform public.phx_release_terminal_manager_ownership(v_employee.hr_id);
  end if;

  return jsonb_build_object(
    'applied', true,
    'employee_hr_id', v_employee.hr_id,
    'vacancy_id', v_existing_vacancy_id,
    'replacement_for_hr_id', v_employee.hr_id
  );
exception
  when undefined_column then
    raise notice 'Terminal employee vacancy guard skipped because expected lifecycle/vacancy columns are missing.';
    return jsonb_build_object('applied', false, 'reason', 'missing_schema_column');
end;
$function$;

-- CREATE OR REPLACE preserves whatever grants the function already carried in production, but the
-- fast migration linter (scripts/check-migrations.mjs) checks each file standalone, matching
-- 20260801200000 and 20260819060000's own re-declaration of the same lockdown on their own
-- redefinitions of this function -- so this one repeats it too rather than relying on history.
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from public;
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from anon;
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from authenticated;
grant execute on function public.phx_ensure_terminal_employee_vacancy(text) to service_role;

-- Remediate the 3 vacancies this bug already opened wrongly. Cancelled, not filled: no real hire
-- ever went through these rows, so a fabricated 'filled' status would misrepresent how the seat
-- actually got occupied and would fire trg_position_vacancies_hire_into_seat for nothing.
update public.position_vacancies
   set status = 'cancelled',
       note = note || E'\nCancelled 2026-08-30: this seat was already occupied by an active employee '
              'when this vacancy was auto-opened -- the terminal vacancy guard never checked current '
              'occupancy before opening it. See migration 20260830130000_terminal_vacancy_guard_checks_occupancy.',
       updated_at = now()
 where id in (356, 358, 360)
   and status = 'open';

commit;

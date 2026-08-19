-- Stop the terminal-employee vacancy guard from turning a routine HR edit into a hard failure.
--
-- SYMPTOM. Any UPDATE to certain terminal employees' rows fails outright. Two different errors,
-- one root behaviour -- the guard insists on opening a vacancy it is not allowed to open:
--
--   (A) ERROR: 23505 duplicate key value violates unique constraint
--              "position_vacancies_vacancy_code_key"
--       DETAIL: Key (vacancy_code)=(VAC-TERM-B168-128cdf) already exists.
--
--   (B) ERROR: 23505 vacancy: an open medical-rep vacancy already exists for this line/area
--              (VAC-AI0004-EQD) - close or cancel it before opening another
--       CONTEXT: PL/pgSQL function public.phx_guard_single_open_rep_vacancy() line 32 at RAISE
--
--   both via: phx_ensure_terminal_employee_vacancy(text) line 88
--             phx_terminal_employee_vacancy_guard_trigger() line 4
--
-- (A) reproduced against production (ozucdzovmcqvepbozvqf) and (B) against staging
-- (cifwmndunmlxjhyjugxa) on 2026-08-19, both while normalising a region label.
-- `phx_employee_terminal_vacancy_guard` is armed on TEN columns -- employment_status,
-- payroll_eligible, organogram_visible, manager_hr_id, department_id, line_id, area_id,
-- position_id, job_title, region_name -- so ordinary HR edits re-run the guard routinely.
--
-- CAUSE (A). The guard's two halves disagree about what "already exists" means.
--
--   * The lookup is STATUS-SCOPED: it searches only for a vacancy with `status = 'open'`.
--   * The code it mints is NOT status-scoped: it is deterministic,
--       'VAC-TERM-' || <hr_id, stripped> || '-' || substr(md5(hr_id || '|' || effective_date), 1, 6)
--     and the effective date is stable for a terminal employee.
--
-- So once a leaver's auto-opened vacancy is CANCELLED or FILLED by a human, the lookup finds
-- nothing, the else-branch mints the very same code, and the INSERT collides with the row it
-- should have recognised. The whole transaction aborts and the employee becomes un-editable.
--
-- CAUSE (B). The lookup also requires a blank `replacement_for_hr_id`, so it does not see an open
-- rep vacancy on the same line/area that belongs to somebody else. The insert then trips
-- `phx_guard_single_open_rep_vacancy`, which correctly refuses a second open medical-rep vacancy
-- for one line/area -- and raises with `errcode = 'unique_violation'`, aborting the edit.
--
-- MEASURED BLAST RADIUS, production, 2026-08-19: SIX employees could not be edited at all --
-- B-85 (collides with filled 291), B-101 (filled 251), B-114 (cancelled 295), B-153 (cancelled
-- 294), B-168 (cancelled 290), B-183 (filled 296). The set grows every time a leaver's vacancy is
-- cancelled or filled, so this is not a six-row cleanup -- it is a live defect.
--
-- FIX. Opening the vacancy becomes best-effort instead of mandatory. The insert carries
-- `on conflict (vacancy_code) do nothing` for (A) and sits inside a plpgsql block that catches
-- `unique_violation` for (B) -- the same SQLSTATE both raise, and the block's subtransaction rolls
-- back only the failed insert, leaving the caller's edit intact. The guard then adopts whatever
-- already exists and returns, instead of aborting.
--
-- Why it must not do more. It deliberately does NOT reopen the row it found:
--
--   * cancelled means a human decided not to backfill this seat. That decision stands.
--   * filled means the replacement already happened. Reopening would invent a phantom vacancy.
--   * in case (B) the line/area already has its one open rep vacancy, which is the invariant
--     phx_guard_single_open_rep_vacancy exists to protect.
--
-- The guard's contract ("a terminal employee is not left without a vacancy record") is already
-- satisfied in every one of those cases, so the fallback only links `replacement_for_hr_id` when
-- it is blank, appends one idempotent note, and returns applied=false with reason
-- 'existing_closed_vacancy' (A) or 'vacancy_insert_blocked' (B). Every caller uses PERFORM and
-- ignores the jsonb, so the new reasons break nothing.
--
-- NOT CHANGED: the open-vacancy lookup, the adopt-the-open-vacancy branch, the code formula, the
-- Africa/Cairo date handling from 20260801200000, the phx_release_terminal_manager_ownership call
-- (which now also runs on the fallback path, matching the normal path), and the trigger's column
-- list. `tests/resignation-completion-vacancy.test.ts` asserts lookup-before-insert and that the
-- insert sits in the else-branch of the existing-vacancy check; both still hold.
--
-- ROLLBACK: re-run 20260801200000_cairo_date_in_replacement_vacancy_functions.sql, which emits the
-- immediately previous body of this function.

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

revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from public;
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from anon;
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from authenticated;
grant execute on function public.phx_ensure_terminal_employee_vacancy(text) to service_role;

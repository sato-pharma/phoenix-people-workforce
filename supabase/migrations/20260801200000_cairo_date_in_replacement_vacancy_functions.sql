-- Cairo-zone the date defaults in the five replacement/vacancy-ownership SQL functions.
--
-- Completes the sweep started by 20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql,
-- which fixed four functions and deliberately deferred these five: a parallel session was
-- reshaping their bodies at the time (20260801150000, 20260801160000 — PRs #1587/#1591). Both
-- have since merged to main, so the bodies re-emitted here are settled, not mid-flight.
--
-- WHY. Production Postgres runs `TimeZone = UTC` (verified live 2026-08-01), while the business,
-- the app and these functions' own writers all work in Africa/Cairo (UTC+3 in summer). An unzoned
-- date inside a function body therefore evaluates to YESTERDAY for the three hours between Cairo
-- 00:00 and 03:00 — UTC 21:00-24:00 of the previous day. Nothing errors; the wrong day is simply
-- used, and then stored.
--
-- WHAT EACH ONE COSTS. An earlier pass labelled all five "cosmetic (note text only)". That is
-- WRONG for three of them; each occurrence below was re-read line by line against the live
-- catalog before this file was generated.
--
--   1. public.phx_ensure_terminal_employee_vacancy(text) — 4 occurrences, and NOT cosmetic.
--      The first is the final fallback of
--        v_effective_date := coalesce(last_working_date, resignation_date, updated_at::date,
--                                     created_at::date, current_date)
--      so an employee carrying none of those dates gets a vacancy STORED one day early. Worse,
--      that same value is fed into
--        substr(md5(hr_id || '|' || coalesce(v_effective_date::text, current_date::text)), 1, 6)
--      which mints the vacancy CODE. A wrong day there does not just mislabel the row — it mints
--      a DIFFERENT code, so the unique index that exists to stop a duplicate vacancy does not
--      match, and the duplicate lands. The remaining two occurrences are note text.
--
--   2. public.phx_autofill_replacement_vacancy_from_employee_insert() — 3 occurrences, NOT
--      cosmetic. Both `coalesce(last_working_date, effective_date, resignation_date, <today>)`
--      and `coalesce(v_effective_date, <today>)` STORE the result on the auto-filled replacement
--      vacancy. This one runs from a trigger on employee insert, so it fires unattended — exactly
--      the path most likely to run inside the 00:00-03:00 window without anyone watching.
--
--   3. public.phx_reassign_replacement_ownership(text,text,date) — 2 occurrences, NOT cosmetic.
--      `v_effective_date date := coalesce(p_effective_date, <today>);` is the STORED handover
--      date whenever the caller passes no explicit date. The second occurrence is note text.
--
--   4. public.phx_reconcile_stale_replacement_vacancies() — 1 occurrence, note text only.
--   5. public.phx_release_terminal_manager_ownership(text) — 1 occurrence, note text only.
--
-- 4 and 5 are re-emitted anyway: leaving a bare unzoned date in a live body is what lets the next
-- reader assume the pattern is fine, and it would keep tripping the recurrence guard.
--
-- WHAT THIS MIGRATION IS. Each body below was produced by running
-- `regexp_replace(pg_get_functiondef(oid), '\mcurrent_date\M', '(now() at time zone
-- ''Africa/Cairo'')::date', 'g')` against the live production catalog and writing the result
-- straight to this file — no body was retyped or reassembled by hand. \m and \M are word
-- boundaries, so an identifier such as `v_current_date` could not have been corrupted; per
-- function, the word-boundary count, the raw count and a count of embedded matches were compared
-- first and were 3/3/0, 4/4/0, 2/2/0, 1/1/0 and 1/1/0 respectively — i.e. every raw match is a
-- standalone keyword and no identifier contains the word. Nothing else in any body changed.
--
-- Bodies come from pg_get_functiondef, so LANGUAGE / VOLATILE / SECURITY DEFINER / SET search_path
-- are carried verbatim. That matters: CREATE OR REPLACE does NOT inherit them, and silently
-- dropping SECURITY DEFINER here would break every caller without direct table access.
--
-- Faithfulness is proved by md5, not by eye: after this file is applied,
-- md5(pg_get_functiondef(oid)) on the target must equal the md5 of the replaced text computed on
-- production. Those five expected hashes are recorded in the PR.
--
-- Idempotent: pure CREATE OR REPLACE plus revoke/grant pairs that are already true in production.
-- No data is touched, and no row is rewritten.

begin;

CREATE OR REPLACE FUNCTION public.phx_ensure_terminal_employee_vacancy(p_employee_hr_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_employee public.employees%rowtype;
  v_existing_vacancy_id bigint;
  v_manager_name text;
  v_vacancy_code text;
  v_effective_date date;
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
    returning id into v_existing_vacancy_id;
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

CREATE OR REPLACE FUNCTION public.phx_autofill_replacement_vacancy_from_employee_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_match_count integer := 0;
  v_vacancy record;
  v_effective_date date;
begin
  if lower(coalesce(new.employment_status, 'active')) not in ('active', 'on_leave') then
    return new;
  end if;

  if coalesce(new.payroll_eligible, true) is not true
     or coalesce(new.organogram_visible, true) is not true then
    return new;
  end if;

  if new.area_id is null
     or new.line_id is null
     or new.position_id is null
     or nullif(trim(coalesce(new.manager_hr_id, '')), '') is null then
    return new;
  end if;

  select count(*)
  into v_match_count
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id;

  -- Avoid guessing when more than one live vacancy has the same footprint.
  if v_match_count <> 1 then
    return new;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id
  order by v.created_at asc, v.id asc
  limit 1;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = new.hr_id,
    filled_at = now(),
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || new.hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
    ),
    updated_at = now()
  where id = v_vacancy.id
    and lower(coalesce(status, 'open')) = 'open';

  if nullif(trim(coalesce(v_vacancy.replacement_for_hr_id, '')), '') is null then
    return new;
  end if;

  select coalesce(last_working_date, effective_date, resignation_date, (now() at time zone 'Africa/Cairo')::date)
  into v_effective_date
  from public.employee_resignations
  where vacancy_id = v_vacancy.id
     or employee_hr_id = v_vacancy.replacement_for_hr_id
  order by created_at desc
  limit 1;

  perform public.phx_reassign_replacement_ownership(
    v_vacancy.replacement_for_hr_id,
    new.hr_id,
    coalesce(v_effective_date, (now() at time zone 'Africa/Cairo')::date)
  );

  return new;
exception
  when undefined_column then
    raise notice 'Replacement ownership auto-fill skipped because expected lifecycle/vacancy columns are missing.';
    return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_reassign_replacement_ownership(p_previous_hr_id text, p_replacement_hr_id text, p_effective_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_previous_hr_id text := upper(trim(coalesce(p_previous_hr_id, '')));
  v_replacement_hr_id text := upper(trim(coalesce(p_replacement_hr_id, '')));
  v_effective_date date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);
  v_previous_status text;
  v_replacement_name text;
  v_replacement_status text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  if v_previous_hr_id = '' or v_replacement_hr_id = '' then
    return jsonb_build_object('applied', false, 'reason', 'missing_hr_id');
  end if;

  if v_previous_hr_id = v_replacement_hr_id then
    return jsonb_build_object('applied', false, 'reason', 'same_hr_id');
  end if;

  select lower(coalesce(employment_status, 'active'))
  into v_previous_status
  from public.employees
  where hr_id = v_previous_hr_id;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if v_previous_status not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  select full_name, lower(coalesce(employment_status, 'active'))
  into v_replacement_name, v_replacement_status
  from public.employees
  where hr_id = v_replacement_hr_id
    and coalesce(payroll_eligible, true) is true
    and coalesce(organogram_visible, true) is true;

  if not found or v_replacement_status not in ('active', 'on_leave') then
    return jsonb_build_object('applied', false, 'reason', 'replacement_employee_not_active');
  end if;

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_reassigned', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', null);
    end;
  end if;

  update public.employees
  set
    manager_hr_id = v_replacement_hr_id,
    pending_manager_replacement_for_hr_id = null,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or pending_manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_reassigned', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_replacement_hr_id,
    manager_name = v_replacement_name,
    manager_replacement_for_hr_id = null,
    note = case
      when coalesce(note, '') ilike '%Replacement ownership engine:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Replacement ownership engine: moved live vacancy manager from '
          || v_previous_hr_id || ' to ' || v_replacement_hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
      )
    end,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_reassigned', v_count);

  if to_regclass('public.sales_records') is not null then
    begin
      execute
        'update public.sales_records
         set manager_hr_id = $2
         where manager_hr_id = $1
           and (
             year > extract(year from $3::date)::integer
             or (
               year = extract(year from $3::date)::integer
               and month >= extract(month from $3::date)::integer
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id, v_effective_date;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('sales_records_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('sales_records_reassigned', null);
    end;
  end if;

  v_result := v_result || jsonb_build_object('sales_targets_reassigned', null);

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous_hr_id,
    'replacement_hr_id', v_replacement_hr_id,
    'effective_date', v_effective_date
  ) || v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_reconcile_stale_replacement_vacancies()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_checked integer := 0;
  v_closed integer := 0;
  r record;
  v_replacement record;
  v_effective_date date;
begin
  for r in
    select
      v.id as vacancy_id,
      v.area_id as vacancy_area_id,
      d.hr_id as departed_hr_id,
      d.manager_hr_id as departed_manager_hr_id,
      d.line_id as departed_line_id,
      d.job_title as departed_job_title,
      coalesce(d.last_working_date, d.resignation_date) as departed_effective_date
    from public.position_vacancies v
    join public.employees d on d.hr_id = v.replacement_for_hr_id
    where lower(coalesce(v.status, 'open')) = 'open'
      and nullif(trim(coalesce(v.replacement_for_hr_id, '')), '') is not null
      and d.manager_hr_id is not null
      and d.line_id is not null
      and nullif(trim(coalesce(d.job_title, '')), '') is not null
  loop
    v_checked := v_checked + 1;

    select a.hr_id
    into v_replacement
    from public.employees a
    where a.manager_hr_id = r.departed_manager_hr_id
      and a.line_id = r.departed_line_id
      and lower(trim(a.job_title)) = lower(trim(r.departed_job_title))
      -- (1) Area guard: the replacement must sit in the seat's own area.
      and a.area_id is not distinct from r.vacancy_area_id
      and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
      and a.hr_id <> r.departed_hr_id
      and (
        r.departed_effective_date is null
        or a.hire_date is null
        or a.hire_date >= r.departed_effective_date
      )
      -- (2) Single-seat guard: never assign someone who already ACTIVELY fills another
      --     seat (status='filled' only — cancelled rows can carry a stale filled_by_hr_id,
      --     and excluding on those would wrongly skip a legitimate reconciliation).
      and not exists (
        select 1
        from public.position_vacancies pv2
        where pv2.filled_by_hr_id = a.hr_id
          and pv2.id <> r.vacancy_id
          and lower(coalesce(pv2.status, 'open')) = 'filled'
      )
    order by a.hire_date asc nulls last
    limit 1;

    if found then
      update public.position_vacancies
      set
        status = 'filled',
        filled_by_hr_id = v_replacement.hr_id,
        filled_at = now(),
        replacement_for_hr_id = null,
        note = concat_ws(
          E'\n',
          nullif(note, ''),
          'Auto-closed by stale-replacement-vacancy reconciliation: seat for '
            || r.departed_hr_id || ' was already filled by ' || v_replacement.hr_id
            || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
        ),
        updated_at = now()
      where id = r.vacancy_id;

      v_closed := v_closed + 1;
    end if;
  end loop;

  return jsonb_build_object('checked', v_checked, 'closed', v_closed);
exception
  when undefined_column then
    raise notice 'Stale-replacement-vacancy reconciliation skipped because expected lifecycle/vacancy columns are missing.';
    return jsonb_build_object('applied', false, 'reason', 'missing_schema_column');
end;
$function$;

CREATE OR REPLACE FUNCTION public.phx_release_terminal_manager_ownership(p_previous_hr_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_previous public.employees%rowtype;
  v_upstream_name text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  select *
  into v_previous
  from public.employees
  where hr_id = upper(trim(coalesce(p_previous_hr_id, '')));

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if lower(coalesce(v_previous.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  if nullif(trim(coalesce(v_previous.manager_hr_id, '')), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'upstream_manager_missing');
  end if;

  select full_name
  into v_upstream_name
  from public.employees
  where hr_id = v_previous.manager_hr_id;

  update public.employees
  set
    manager_hr_id = v_previous.manager_hr_id,
    pending_manager_replacement_for_hr_id = v_previous.hr_id,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_released_to_upstream', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_previous.manager_hr_id,
    manager_name = v_upstream_name,
    manager_replacement_for_hr_id = v_previous.hr_id,
    note = case
      when coalesce(note, '') ilike '%Pending replacement ownership:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Pending replacement ownership: temporarily moved from terminal manager '
          || v_previous.hr_id || ' to upstream manager ' || v_previous.manager_hr_id
          || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
      )
    end,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_released_to_upstream', v_count);

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', null);
    end;
  end if;

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous.hr_id,
    'upstream_manager_hr_id', v_previous.manager_hr_id
  ) || v_result;
end;
$function$;

-- Self-contained re-assertion of the intended grants.
--
-- All five already read {postgres=X/postgres, service_role=X/postgres} in production, so these
-- revokes are no-ops there. They are NOT no-ops everywhere. A REVOKE against a function whose ACL
-- is still the default NULL means "PUBLIC has EXECUTE"; the first revoke MATERIALISES that ACL and
-- drops the PUBLIC entry — taking service_role's access with it, because service_role held EXECUTE
-- only by virtue of being a member of PUBLIC. That is a silent fail-closed: the revoke succeeds,
-- and the next service_role call is the thing that fails. It bit staging during the 20260801180000
-- pass, which is why every revoke below is paired with an explicit grant rather than relying on
-- inheritance. Together the two halves make the end state identical in every environment
-- regardless of what the ACL was before — PUBLIC cannot execute, service_role can. Both idempotent.
--
-- Verify with has_function_privilege(role, oid, 'EXECUTE'), never by reading the body.
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text) from public;
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() from public;
revoke execute on function public.phx_reassign_replacement_ownership(text,text,date) from public;
revoke execute on function public.phx_reconcile_stale_replacement_vacancies() from public;
revoke execute on function public.phx_release_terminal_manager_ownership(text) from public;

grant execute on function public.phx_ensure_terminal_employee_vacancy(text) to service_role;
grant execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() to service_role;
grant execute on function public.phx_reassign_replacement_ownership(text,text,date) to service_role;
grant execute on function public.phx_reconcile_stale_replacement_vacancies() to service_role;
grant execute on function public.phx_release_terminal_manager_ownership(text) to service_role;

commit;

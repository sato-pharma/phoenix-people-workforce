-- A departure revokes the login on the LAST WORKING DAY, not the day the exit is filed.
--
-- WHY. This function set `app_auth_users.is_active = false` unconditionally, at the moment HR
-- recorded the exit. HR files exits in advance, so an employee still working out their notice was
-- locked out days early — and the lockout is indistinguishable from a forgotten password.
--
-- A-16, 2026-08-30. Her exit was filed 2026-08-28 for a 2026-08-31 last working day. On the 30th
-- she failed to sign in nine times; HR re-activated her account by hand at 09:55:18 Cairo, then ran
-- two password resets and a password setup inside four minutes. None of it could work: after the
-- re-activation the refusal came from `employees.employment_status`, which the auth gate now reads
-- together with `last_working_date` (src/lib/auth/session-lifecycle.ts, isEmploymentAccessRevoked).
-- This migration is the other half — it stops the login being switched off early in the first
-- place, so HR never has to re-activate anyone by hand again.
--
-- SAFETY. Deferring the flag does NOT open a window. From the last working day onward the auth
-- gate refuses the session on employment_status regardless of `is_active`, and the daily leaver
-- sweep (src/lib/auth/departed-access-sweep.ts) flips the flag itself once the day arrives. So the
-- flag can only ever lag the block, never lead it. `is_active` also stays available as the
-- immediate kill switch: an admin deactivating a login by hand is untouched by this, which is what
-- a termination for cause uses.
--
-- A NULL effective date keeps the old behaviour and revokes at once — no date means no grace, the
-- same rule the application gate applies.

create or replace function public.phx_resign_employee_and_open_vacancy(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_employee_status text,
  p_reason text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text,
  p_workflow_notes text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_employee public.employees;
  v_line_name text;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_resignation_id uuid;
  v_seat_id text;
begin
  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_resign_employee_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;

  select name into v_line_name from public.lines where id = v_employee.line_id;
  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;

  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;

  insert into public.employee_resignations (
    employee_hr_id, employee_name, job_title, line_name,
    submitted_date, effective_date, resignation_date, last_working_date,
    reason, notes, workflow_notes, exit_status, status,
    create_vacancy, vacancy_id, submitted_by_hr_id, created_by, created_at, updated_at
  ) values (
    p_employee_hr_id, v_employee.full_name, coalesce(v_position_title, v_employee.job_title), v_line_name,
    p_submitted_date, p_effective_date, p_submitted_date, p_effective_date,
    p_reason, coalesce(p_workflow_notes, p_reason), p_workflow_notes, 'submitted', 'submitted',
    true, v_vacancy_id, p_submitted_by_hr_id, p_actor, now(), now()
  )
  returning id into v_resignation_id;

  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    -- crm_id is released so the replacement hire can inherit the slot (owner rule 2026-08-05).
    -- crm_username is deliberately KEPT: it is what lets the CRM sync still recognise this
    -- person's own trailing visits.
    crm_id = null,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- THE CHANGE. Revoke the login only once the last working day has arrived. An exit filed in
  -- advance leaves the account alone until then; the auth gate is what refuses the session from
  -- the last working day onward, and the daily leaver sweep flips this flag when the day comes.
  if p_effective_date is null or p_effective_date <= (now() at time zone 'Africa/Cairo')::date then
    update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
    update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  end if;

  for v_seat_id in
    select seat_id
    from au.occupancy_history
    where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
      and effective_to is null
      and node_type = 'person'
    order by seat_id
  loop
    perform au.resign_occupant(v_seat_id, p_effective_date, coalesce(p_reason, 'resignation'), p_actor);
  end loop;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_code', p_vacancy_code
  );
end;
$function$;

-- Lock the function down explicitly rather than relying on the ACL it already carries.
-- `create or replace` PRESERVES an existing ACL, and production's is already right
-- (postgres, service_role — PUBLIC revoked), so on production these two statements change nothing.
-- On a database where this function does NOT yet exist, `create or replace` acts as `create` and
-- the function would be born with PostgreSQL's default EXECUTE grant to PUBLIC — callable with the
-- anonymous key. anon and authenticated are MEMBERS of PUBLIC, so revoking only those two is a
-- no-op; PUBLIC itself is what has to go. The revoke comes FIRST because stripping PUBLIC from a
-- default ACL also strips service_role.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) to service_role;

-- The catch-up that makes deferring safe to operate: once the last working day arrives, something
-- has to actually flip the flag. This is that something. The daily leaver cron calls it
-- (src/lib/auth/departed-access-sweep.ts), and it is idempotent, so a missed day self-heals on the
-- next run.
--
-- IT IS A SQL FUNCTION RATHER THAN CLIENT CODE for two reasons this repository has been bitten by.
-- HR ids are MIXED CASE, so a PostgREST .eq()/.in() silently under-matches — both sides are lowered
-- and trimmed here. And a PostgREST .in() carrying several hundred ids returns zero rows with no
-- error; one statement has no such cliff.
--
-- NOT a security hole while it lags: from the last working day the auth gate refuses login and
-- session on employment_status regardless of is_active, so a run that fails leaves a stale flag,
-- never an open door.
create or replace function public.phx_revoke_departed_employee_access()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_logins integer := 0;
  v_profiles integer := 0;
  v_revoked text[] := '{}';
begin
  -- The revoked ids are RETURNED, not just counted. Disabling the leaver's Telegram is an external
  -- API call that cannot happen inside SQL, and the resignation flow no longer does it at filing
  -- time (it is dated now, like everything else here) — so the caller has to finish the job, and it
  -- can only do that if it is told who. Counting alone would silently leave ex-employees receiving
  -- company notifications, which is worse than the early-lockout bug this whole change removes.
  with departed as (
    select lower(btrim(e.hr_id)) as hr_id
    from public.employees e
    where lower(btrim(coalesce(e.employment_status, ''))) in ('resigned', 'terminated', 'not_renewed')
      and e.last_working_date is not null
      and e.last_working_date <= (now() at time zone 'Africa/Cairo')::date
  ),
  revoked as (
    update public.app_auth_users a
    set is_active = false, updated_at = now()
    from departed d
    where lower(btrim(a.hr_id)) = d.hr_id
      and a.is_active
    returning a.hr_id
  )
  select coalesce(array_agg(r.hr_id order by r.hr_id), '{}') into v_revoked from revoked r;
  v_logins := coalesce(array_length(v_revoked, 1), 0);

  with departed as (
    select lower(btrim(e.hr_id)) as hr_id
    from public.employees e
    where lower(btrim(coalesce(e.employment_status, ''))) in ('resigned', 'terminated', 'not_renewed')
      and e.last_working_date is not null
      and e.last_working_date <= (now() at time zone 'Africa/Cairo')::date
  )
  update public.user_access_profiles u
  set is_active = false, updated_at = now()
  from departed d
  where lower(btrim(u.hr_id)) = d.hr_id
    and u.is_active;
  get diagnostics v_profiles = row_count;

  return jsonb_build_object(
    'logins_revoked', v_logins,
    'access_profiles_revoked', v_profiles,
    'revoked_hr_ids', to_jsonb(v_revoked)
  );
end;
$function$;

-- Same reasoning, and here it is not theoretical: this function is new, so it really would be
-- born callable by anon and authenticated through their PUBLIC membership — a function that
-- switches off employee logins. Revoke PUBLIC, then re-grant service_role, in that order.
revoke execute on function public.phx_revoke_departed_employee_access() from public, anon, authenticated;
grant execute on function public.phx_revoke_departed_employee_access() to service_role;

-- Run it once now, so applying this migration leaves production correct immediately instead of
-- waiting for the next 08:15 Cairo cron.
--
-- Expected to touch ONE login on production as of 2026-09-03: A-16, whose account HR re-activated
-- by hand on 2026-08-30 to work around the early lockout and which was never switched back off.
-- The predicate needs BOTH a departed status AND a last working day in the past, so it can never
-- reach anyone still employed or serving notice.
select public.phx_revoke_departed_employee_access();

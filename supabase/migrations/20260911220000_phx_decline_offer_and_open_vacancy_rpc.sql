-- Owner-requested shortcut for an employee who accepted an offer, was entered into
-- `employees`, then backed out within a short window after hiring (better offer
-- elsewhere, never really started, or worked only a few days). Distinct from a real
-- resignation: it must be usable without the resignation workflow's framing, must
-- reopen the seat/vacancy the same way, and must let HR choose per case whether the
-- person is entered into that month's payroll for the days they did work.
--
-- Deliberately does NOT insert into `employee_resignations`. That table is what the
-- automated payroll engine's leaver feeder reads (src/lib/payroll/copilot/feeders.ts)
-- to decide who gets a full resignation-grade settlement (allowances, >25th waiver).
-- A person who reneged on an offer is not a resignation, so this RPC never creates a
-- row that engine would pick up — see the paired application-code change in the same
-- commit (src/lib/resignations/service.ts, declineOfferAndOpenVacancy) for the full
-- reasoning on how `p_employee_status` is chosen (`terminated` vs the new
-- `declined_offer`) to route Ready Payroll's own inclusion correctly.
--
-- Modeled directly on phx_resign_employee_and_open_vacancy
-- (20260718210000_phx_resign_employee_and_open_vacancy_rpc.sql): same vacancy-opening
-- shape, same employees-lifecycle update shape, same access-deactivation step, same
-- seat-vacate guard. The resignation-record insert is the one step removed.

alter table public.employees add column if not exists exit_category text;
comment on column public.employees.exit_category is
  'Optional exit sub-classification, independent of employment_status and exit_reason. '
  'Currently only ''declined_offer'' is written, by the owner-approved <=30-day '
  'decline/renege-after-hire workflow (phx_decline_offer_and_open_vacancy). Nullable; '
  'absent for every ordinary exit.';

create or replace function public.phx_decline_offer_and_open_vacancy(
  p_actor text,
  p_employee_hr_id text,
  p_employee_status text,
  p_last_working_date date,
  p_note text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_seat_id text;
begin
  if p_employee_status not in ('terminated', 'declined_offer') then
    raise exception 'phx_decline_offer_and_open_vacancy: employee status must be terminated or declined_offer, got %', p_employee_status;
  end if;

  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_decline_offer_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;

  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;

  -- 1. Open the replacement vacancy (mirrors the resignation RPC's step 1).
  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from declined offer of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Last day ' || p_last_working_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;

  -- 2. Update the employee's own lifecycle fields. No employee_resignations row is
  --    written here — see the file header. exit_category is the durable, findable
  --    marker independent of which employment_status this exit lands on.
  update public.employees set
    employment_status = p_employee_status,
    exit_category = 'declined_offer',
    exit_reason = p_note,
    last_working_date = p_last_working_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 3. Deactivate app access (DB-side only; Telegram deactivation is an external API
  --    call and stays in application code, same as the resignation RPC).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 4. Vacate the au seat, if any, in the same transaction (identical guard to the
  --    resignation RPC's step 5). A brand-new hire with no replacement_for_hr_id never
  --    occupies a seat at all, so this is routinely a no-op.
  select seat_id into v_seat_id
  from au.occupancy_history
  where occupant_hr_id = p_employee_hr_id and effective_to is null and node_type = 'person'
  limit 1;
  if v_seat_id is not null then
    perform au.resign_occupant(v_seat_id, p_last_working_date, coalesce(p_note, 'declined offer after hire'), p_actor);
  end if;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'vacancy_code', p_vacancy_code
  );
end;
$$;

-- The `public` schema auto-grants EXECUTE to `authenticated` on every new function
-- (see the identical note in the resignation RPC migration) — both revokes are
-- required or this RPC is callable by any Supabase-authenticated session via
-- PostgREST, bypassing every app-layer permission/workflow check.
revoke execute on function public.phx_decline_offer_and_open_vacancy(text,text,text,date,text,text,date,text) from public;
revoke execute on function public.phx_decline_offer_and_open_vacancy(text,text,text,date,text,text,date,text) from authenticated;
grant execute on function public.phx_decline_offer_and_open_vacancy(text,text,text,date,text,text,date,text) to service_role;

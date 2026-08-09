-- Resignation released the leaver's WHOLE CRM identity: `crm_id = null` AND `crm_username = null`.
-- Only the first is needed, and the second silently destroys visit attribution.
--
-- The CRM sync stamps `ireports360_visits.agent_hr_id` ONCE, at sync time, via the waterfall in
-- src/lib/crm/identity.ts: manual override -> employees.crm_id -> unique employees.crm_username.
-- Clearing both automatic tiers the instant a resignation is processed means every visit synced
-- after that moment resolves to NULL -- including visits the person genuinely performed while
-- still employed, because the mirror is synced a day or more behind the visit date. The NULL is
-- then stored permanently.
--
-- Measured on production 2026-08-09: ALL 56 departed employees have crm_username = NULL (not one
-- exception), and 587 visits dated ON OR BEFORE their own last working day sit unattributed
-- because of it. Two worked examples:
--   * B-176 (Eman Essam)   resigned 07-06 13:38 -> 21 visits 07-11..07-13 stranded
--   * B-111 (Amany Wasiem) resigned 07-17 04:03 -> 36 visits 07-06..07-12 stranded
-- Both rows still carry the person's own unmistakable CRM label ("Amany.Wasiem ( Assuit 1 / F )",
-- identical on the attributed and unattributed rows). The name that identifies them was right
-- there; the roster column it is matched against had been erased.
--
-- It also disables the post-exit guard's only escape hatch. isAttributableOn() is written to allow
-- a post-exit row when the record still carries THIS employee's own CRM label -- but the label it
-- compares against IS crm_username, so `if (!ownLabel || !recordLabel) return false;` fires every
-- time for exactly the population the guard was written for.
--
-- WHY crm_id STILL GETS CLEARED (do not "simplify" this into clearing neither). A leaver holding
-- crm_id blocked their own successor's master import with "CRM ID 1399 is already assigned to
-- HR_ID B-97" -- employees_crm_id_unique_idx is unique across ALL employees regardless of
-- employment_status, and the employee-import validator maps crm_id -> hr_id with no active-only
-- filter. 30 leavers were holding one. That is the owner rule from 2026-08-05 and it stands.
--
-- Keeping crm_username does NOT reintroduce that conflict. The numeric SLOT is what gets handed to
-- a replacement; the display name is not. Production slots 1102/1395/1399 each carry two different
-- people's names in their history precisely because the successor arrives under their OWN label.
-- employees_crm_username_unique_idx therefore only ever fires if HR tries to give one person's
-- exact CRM display name to somebody else, which should be refused anyway.
--
-- Net effect: tier 2 still releases the slot for the successor, tier 3 now still resolves the
-- leaver's own trailing visits, and the post-exit guard can finally do its intended job -- allow a
-- row carrying the leaver's label, block one carrying the replacement's.
--
-- Body is otherwise byte-for-byte the deployed definition (read from pg_get_functiondef, not the
-- migration ledger). The ONLY change is the removal of `crm_username = null,`.
create or replace function public.phx_resign_employee_and_open_vacancy(
  p_actor text, p_effective_date date, p_employee_hr_id text, p_employee_status text,
  p_reason text, p_submitted_by_hr_id text, p_submitted_date date, p_vacancy_code text,
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
    -- person's own trailing visits. See the header of this migration.
    crm_id = null,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

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

-- `create or replace` preserves the existing ACL, so these two lines are a no-op against production
-- as it stands today — they restate it explicitly rather than change it. Verified live 2026-08-09
-- before writing them: proacl is exactly `postgres=X/postgres | service_role=X/postgres`, i.e.
-- anon/authenticated already hold nothing. They are here because a SECURITY DEFINER function that
-- rewrites employment status, deactivates auth users and vacates org seats must never depend on an
-- ACL it does not state -- a future `create or replace` in an environment where this function does
-- not yet exist would otherwise inherit the default PUBLIC EXECUTE. The GRANT follows the REVOKE on
-- purpose: revoking PUBLIC on a default ACL strips service_role along with it.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) to service_role;

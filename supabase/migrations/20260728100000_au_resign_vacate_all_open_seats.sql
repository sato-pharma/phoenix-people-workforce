-- =============================================================================
-- RESIGNATION MUST VACATE EVERY au SEAT THE DEPARTING EMPLOYEE OCCUPIES
-- =============================================================================
-- GAP (found 2026-07-28 while wiring the hire side in 20260728010000): step 5 of
-- public.phx_resign_employee_and_open_vacancy located the resigning employee's au seat
-- with
--     select seat_id into v_seat_id from au.occupancy_history
--     where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
--       and effective_to is null and node_type = 'person'
--     limit 1;                                   -- <-- no ORDER BY, and only ONE row
-- then vacated that single seat. au.occupancy_history has no per-hr_id uniqueness: one
-- person can hold more than one open span at once. There is exactly one such occupant in
-- production today — B-1, a medical rep who ALSO holds an ACTING_DM seat:
--     SEAT-AIF-REP-UE1   (REP)
--     SEAT-AIF-ADM-UE-1  (ACTING_DM)
-- both with effective_to IS NULL. If B-1 resigned under the old code, `limit 1` (with no
-- ORDER BY, so the row is whatever the planner returned) would close ONE of the two and
-- leave the OTHER open forever — a departed employee still shown as the sitting occupant.
-- That is the exact "vacated seat still reads as staffed" defect class that #1399 and
-- #1411 have been closing, one surface at a time.
--
-- WHY A LOOP, NOT JUST `ORDER BY ... LIMIT 1`: making the pick deterministic would still
-- leave the second seat occupied by someone who has left the company. A resigned employee
-- cannot occupy ANY seat, so EVERY open person-span of theirs must close. This replaces the
-- single-row lookup with a loop over all of them. For the 131 single-seat occupants the
-- behaviour is byte-identical (the loop runs exactly once); only B-1's dual-seat case
-- changes, and it changes from "one seat silently left stale" to "both correctly vacated".
--
-- INTERACTION WITH #1399's area_state sync (au.sync_area_state_for_seat, called inside
-- au.resign_occupant): that sync only fires for seat_tier = 'REP'. So vacating B-1 flips
-- their REP area (UE1) to 'vacant_will_hire' — correct, the area now needs a rep — while
-- vacating the ACTING_DM seat touches no area_state, which is also correct (an acting-DM
-- overlay is not a rep-staffing fact). No double-counting, no payout impact: carries_target
-- is true for both 'occupied' and 'vacant_will_hire' (see #1399).
--
-- SCOPE: this is the ONLY change. The rest of the function body is reproduced verbatim from
-- 20260727214733_au_period_aware_seat_resolvers.sql (which is itself verbatim from
-- 20260718210000 plus that migration's Fix-3 canonical-HR_ID change). search_path stays ''
-- so every reference is fully qualified.
--
-- BEHAVIOUR ON TODAY'S DATA: identical for everyone except B-1, and B-1 has not resigned —
-- so applying this migration changes NO existing row. It only changes what a FUTURE
-- resignation of a multi-seat occupant does. Verified read-only: exactly one occupant
-- (B-1) currently has >1 open person-span.
--
-- Regression guard: tests/au-seat-occupant-resolver.test.ts (section 6, extended to forbid
-- the single-row `limit 1` vacate and require the loop).
-- =============================================================================

begin;

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
set search_path = ''
as $$
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

  -- 1. Open the replacement vacancy (mirrors insertFallbackVacancy's full payload).
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

  -- 2. Record the resignation (mirrors insertResignationRecord's full payload).
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

  -- 3. Update the employee's own lifecycle fields (mirrors updateEmployeeLifecycleFallback).
  --    This UPDATE fires the existing terminal-lifecycle triggers exactly as the JS
  --    fallback's equivalent UPDATE always has — no trigger logic is duplicated here.
  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 4. Deactivate app access (DB-side only; Telegram deactivation is an external API
  --    call and must stay in application code — see the note at the top of this file).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 5. Fix-3 (now covers EVERY seat, not just the first): vacate every au seat the resigning
  --    employee currently occupies, in the SAME transaction. Was `limit 1` with no ORDER BY,
  --    which on the model's one dual-seat occupant (B-1: SEAT-AIF-REP-UE1 + SEAT-AIF-ADM-UE-1)
  --    would non-deterministically close only ONE and leave the other showing a departed
  --    occupant forever. A resigned employee cannot occupy any seat, so all their open
  --    person-spans must close. Matched on the generated canonical HR_ID: a raw comparison
  --    silently misses on any casing/whitespace difference. Ordered by seat_id purely for a
  --    stable, reproducible vacate order (the set of seats closed is the same regardless).
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
$$;

-- The `public` schema has a project-wide default ACL that auto-grants EXECUTE to
-- `authenticated` on every new function — `revoke ... from public` alone does NOT
-- remove that direct grant. Both revokes are required or this RPC is callable by any
-- Supabase-authenticated session via PostgREST, bypassing every app-layer
-- permission/workflow check normally gating a resignation.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from public;
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) to service_role;

notify pgrst, 'reload schema';

commit;

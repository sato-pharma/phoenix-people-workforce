-- Probation scope fix (owner rule, 2026-07-17): the probation module is MEDICAL-REPRESENTATIVE-ONLY.
--
-- The Phase-2 auto-provisioning trigger (20260713131000) provisions a probation case for EVERY new
-- hire still inside the hire+90 window, with no job-title filter. That put managers (District /
-- Regional Sales Manager) and head-office roles (Admin Assistant) into the module alongside the
-- medical reps. This recreates the trigger function with an added guard so only medical reps are
-- ever provisioned. The app-layer guard (ensureProbationCase / backfill isMedicalRepresentativeTitle)
-- is the defense-in-depth twin of this DB-layer guard.
--
-- Matched on a normalized "medical rep" substring so title variants (e.g. "Senior Medical
-- Representative") are covered while every manager/admin title is excluded. Idempotent, non-blocking,
-- and window-guarded exactly as before — only the job-title guard is added.

begin;

create or replace function public.probation_provision_case_on_hire()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard: need identity + a hire date to anchor the window.
  if new.hr_id is null or new.hire_date is null then
    return new;
  end if;
  -- Guard: skip already-exited employees.
  if lower(coalesce(new.employment_status, 'active')) in ('terminated', 'resigned', 'inactive') then
    return new;
  end if;
  -- Guard: MEDICAL-REPRESENTATIVE-ONLY (owner rule 2026-07-17). Managers and head-office roles never
  -- get a probation case. Substring match covers "Medical Representative" + future variants.
  if position('medical rep' in lower(coalesce(new.job_title, ''))) = 0 then
    return new;
  end if;
  -- Guard: only provision hires still inside the 90-day window (protects bulk imports of
  -- long-tenured staff from spawning spurious cases).
  if (new.hire_date + interval '90 days')::date <= current_date then
    return new;
  end if;

  begin
    insert into public.probation_cases (
      employee_hr_id, employee_name, job_title, line_name, area_name, manager_hr_id,
      hire_date, probation_start_date, probation_end_date, status, source, created_by
    ) values (
      new.hr_id, new.full_name, new.job_title, new.line_name, new.area_name, new.manager_hr_id,
      new.hire_date, new.hire_date, (new.hire_date + interval '90 days')::date,
      'active', 'hire_trigger', 'system'
    )
    on conflict (employee_hr_id) do nothing;
  exception when others then
    -- Provisioning must NEVER block a hire. Record and continue.
    begin
      insert into public.probation_provisioning_failures (employee_hr_id, source, error_message)
      values (new.hr_id, 'hire_trigger', sqlerrm);
    exception when others then
      null; -- even the failure-log insert must not break the hire
    end;
  end;

  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;

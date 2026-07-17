-- Probation Case auto-provisioning (Phase 2) — single guaranteed hook for ALL hire paths.
--
-- The audit found the app-layer provisioning (createInitialProbationRecord) was wired into only
-- ONE of four hire paths (recruitment approve-and-convert) and was bypassed in practice. Rather
-- than wire N application sites (and risk a future 5th path slipping through), we provision at the
-- one place every hire path converges: an AFTER INSERT trigger on public.employees. Covers the
-- security-definer offer RPC inserts AND the PostgREST upserts (manual add + bulk import) at once.
--
-- Safety by design:
--   * Window-guarded: only provisions a genuinely new hire still inside the 90-day window and not
--     already exited. Historical/bulk re-imports with old hire dates never spawn a case.
--   * Idempotent: ON CONFLICT (employee_hr_id) DO NOTHING — re-inserts/upserts never duplicate.
--   * NON-BLOCKING: the whole body is exception-guarded so a probation-provisioning error can never
--     roll back or block a hire. Failures are recorded to probation_provisioning_failures for
--     monitoring (NOT silently swallowed).
--   * Same canonical rule as the app layer: probation_end_date = hire_date + 90 days.

begin;

-- Monitoring sink: provisioning failures are surfaced here, never silently dropped.
create table if not exists public.probation_provisioning_failures (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text,
  source text not null default 'hire_trigger',
  error_message text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_probation_provisioning_failures_unresolved
  on public.probation_provisioning_failures (created_at) where resolved_at is null;
alter table public.probation_provisioning_failures enable row level security;

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
  -- Guard: only provision hires still inside the 90-day window (protects bulk imports of
  -- long-tenured staff from spawning spurious cases).
  if (new.hire_date + interval '90 days')::date <= current_date then
    return new;
  end if;

  begin
    insert into public.probation_cases (
      employee_hr_id, employee_name, line_name, area_name, manager_hr_id,
      hire_date, probation_start_date, probation_end_date, status, source, created_by
    ) values (
      new.hr_id, new.full_name, new.line_name, new.area_name, new.manager_hr_id,
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

drop trigger if exists trg_probation_provision_case_on_hire on public.employees;
create trigger trg_probation_provision_case_on_hire
  after insert on public.employees
  for each row
  execute function public.probation_provision_case_on_hire();

notify pgrst, 'reload schema';

commit;

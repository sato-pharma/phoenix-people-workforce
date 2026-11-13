create extension if not exists pgcrypto;

create table if not exists public.employee_resignations (
  id uuid primary key default gen_random_uuid()
);

alter table public.employee_resignations
  add column if not exists employee_hr_id text,
  add column if not exists employee_name text,
  add column if not exists job_title text,
  add column if not exists line_name text,
  add column if not exists submitted_date date,
  add column if not exists effective_date date,
  add column if not exists reason text,
  add column if not exists workflow_notes text,
  add column if not exists status text,
  add column if not exists created_by text,
  add column if not exists created_at timestamptz,
  add column if not exists updated_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_reason text,
  add column if not exists completed_at timestamptz,
  add column if not exists completed_by text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text;

update public.employee_resignations
set
  status = coalesce(nullif(status, ''), 'submitted'),
  submitted_date = coalesce(submitted_date, current_date),
  effective_date = coalesce(effective_date, coalesce(submitted_date, current_date)),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now())
where
  status is null
  or submitted_date is null
  or effective_date is null
  or created_at is null
  or updated_at is null;

alter table public.employee_resignations
  alter column employee_hr_id set not null,
  alter column employee_name set not null,
  alter column submitted_date set not null,
  alter column effective_date set not null,
  alter column status set default 'submitted',
  alter column status set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'employee_resignations_status_check'
  ) then
    alter table public.employee_resignations
      add constraint employee_resignations_status_check
      check (
        status in ('submitted', 'under_review', 'approved', 'rejected', 'completed', 'cancelled')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'employee_resignations_effective_after_submitted'
  ) then
    alter table public.employee_resignations
      add constraint employee_resignations_effective_after_submitted
      check (effective_date >= submitted_date);
  end if;
end $$;

create index if not exists employee_resignations_employee_hr_id_idx
  on public.employee_resignations (employee_hr_id);

create index if not exists employee_resignations_status_idx
  on public.employee_resignations (status);

create index if not exists employee_resignations_effective_date_idx
  on public.employee_resignations (effective_date);

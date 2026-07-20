-- Automated Payroll — HR-owned monthly salary-sheet wizard (staging state).
--
-- Brand-new module; add-only. These four tables hold the wizard's own working
-- state (run lifecycle, per-step confirmation, per-employee editable draft rows,
-- audit). The canonical salary_batches/salary_records are written once, at the
-- separate Super-Admin publish step — never here.
--
-- RLS mirrors the payroll_copilot_* staging tables exactly: service_role (the
-- app's admin client) bypasses RLS; authenticated access is gated by
-- public.current_access_can_manage_employees() (Super Admin / HR). No anon grant,
-- no employee-self policy — staging is never employee-facing.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.automated_payroll_runs (
  id                  uuid primary key default gen_random_uuid(),
  month               integer not null,
  year                integer not null,
  month_key           text generated always as (year::text || '-' || lpad(month::text, 2, '0')) stored,
  phase               text not null default 'part1',
  part1_confirmed_at  timestamptz,
  part1_confirmed_by  text,
  part2_confirmed_at  timestamptz,
  part2_confirmed_by  text,
  published_batch_id  uuid references public.salary_batches(id) on delete set null,
  published_at        timestamptz,
  published_by        text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint automated_payroll_runs_month_check check (month >= 1 and month <= 12),
  constraint automated_payroll_runs_year_check check (year >= 2000 and year <= 2100),
  constraint automated_payroll_runs_phase_check
    check (phase in ('part1', 'part2', 'ready', 'published', 'cancelled'))
);

-- At most ONE active run per period (mirrors payroll_copilot_runs_active_period_idx).
create unique index if not exists automated_payroll_runs_active_period_idx
  on public.automated_payroll_runs (month, year)
  where phase in ('part1', 'part2', 'ready');
create index if not exists automated_payroll_runs_period_idx
  on public.automated_payroll_runs (year, month);

create table if not exists public.automated_payroll_step_state (
  run_id        uuid not null references public.automated_payroll_runs(id) on delete cascade,
  step_key      text not null,
  status        text not null default 'pending',
  input_mode    text,
  summary       jsonb not null default '{}'::jsonb,
  confirmed_at  timestamptz,
  confirmed_by  text,
  updated_at    timestamptz not null default now(),
  primary key (run_id, step_key),
  constraint automated_payroll_step_state_status_check check (status in ('pending', 'confirmed')),
  constraint automated_payroll_step_state_input_mode_check
    check (input_mode is null or input_mode in ('inline', 'xlsx'))
);

create table if not exists public.automated_payroll_draft_rows (
  run_id                   uuid not null references public.automated_payroll_runs(id) on delete cascade,
  employee_hr_id           text not null,
  employee_hr_id_compact   text not null,
  base_for_month           numeric(14, 2),
  ecol_paid                numeric(14, 2),
  fuel_paid                numeric(14, 2),
  fingerprint_days         numeric(8, 2),
  fingerprint_value        numeric(14, 2),
  expenses                 numeric(14, 2),
  incentive                numeric(14, 2),
  bonus                    numeric(14, 2),
  overtime                 numeric(14, 2),
  unpaid_vacations         numeric(14, 2),
  crm                      numeric(14, 2),
  manual_other_deductions  numeric(14, 2),
  manual_reason            text,
  first_part_frozen        numeric(14, 2),
  on_hold                  boolean not null default false,
  hold_reason              text,
  source                   text not null default 'inline',
  edited_by                text,
  updated_at               timestamptz not null default now(),
  primary key (run_id, employee_hr_id_compact),
  constraint automated_payroll_draft_rows_source_check check (source in ('inline', 'xlsx'))
);
create index if not exists automated_payroll_draft_rows_run_idx
  on public.automated_payroll_draft_rows (run_id);

create table if not exists public.automated_payroll_audit (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.automated_payroll_runs(id) on delete cascade,
  actor_hr_id text,
  action      text not null,
  step_key    text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists automated_payroll_audit_run_idx
  on public.automated_payroll_audit (run_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — HR/Super Admin only (service_role bypasses RLS)
-- ---------------------------------------------------------------------------

alter table public.automated_payroll_runs        enable row level security;
alter table public.automated_payroll_step_state  enable row level security;
alter table public.automated_payroll_draft_rows  enable row level security;
alter table public.automated_payroll_audit       enable row level security;

do $$
declare
  target_table text;
  targets text[] := array[
    'automated_payroll_runs',
    'automated_payroll_step_state',
    'automated_payroll_draft_rows',
    'automated_payroll_audit'
  ];
begin
  foreach target_table in array targets loop
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_select', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_insert', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_update', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_delete', target_table);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_select', target_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.current_access_can_manage_employees())',
      target_table || '_admin_insert', target_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.current_access_can_manage_employees()) with check (public.current_access_can_manage_employees())',
      target_table || '_admin_update', target_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_delete', target_table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants — no anon; authenticated is RLS-gated; service_role full
-- ---------------------------------------------------------------------------

do $$
declare
  target_table text;
  targets text[] := array[
    'automated_payroll_runs',
    'automated_payroll_step_state',
    'automated_payroll_draft_rows',
    'automated_payroll_audit'
  ];
begin
  foreach target_table in array targets loop
    execute format('revoke all on table public.%I from anon', target_table);
    execute format('revoke all on table public.%I from public', target_table);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
  end loop;
end $$;

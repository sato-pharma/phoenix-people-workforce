-- Payroll Copilot — Phase 1 tables
--
-- The Payroll Copilot assembles a monthly payroll draft from existing modules,
-- negotiates flagged people with the CEO in chat, and materializes the result
-- into the EXISTING salary_batches / salary_records machinery. These four tables
-- hold the Copilot's own working state (the run, its flags, the manual
-- adjustments applied during negotiation, and cross-month recurring items).
--
-- No columns are added to salary_records; the Copilot writes into existing
-- columns via the existing phx_create_salary_batch path at materialization time.
--
-- RLS mirrors salary_batches: writes require current_access_can_manage_employees().
-- The API layer further restricts triggering a run to CEO + Super Admin, and the
-- server writes through the service-role client (which bypasses RLS); these
-- policies are defense-in-depth against any direct anon/user access.

-- 1) One row per monthly Copilot run.
create table if not exists public.payroll_copilot_runs (
  id uuid primary key default gen_random_uuid(),
  month integer not null check (month between 1 and 12),
  year integer not null check (year between 2000 and 2100),
  status text not null default 'assembling'
    check (status in ('assembling', 'negotiating', 'drafted', 'cancelled')),
  salary_batch_id uuid null references public.salary_batches (id) on delete set null,
  green_count integer not null default 0,
  flagged_count integer not null default 0,
  employee_count integer not null default 0,
  period_label text null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active (non-terminal) run per period.
create unique index if not exists payroll_copilot_runs_active_period_idx
  on public.payroll_copilot_runs (month, year)
  where status in ('assembling', 'negotiating');

create index if not exists payroll_copilot_runs_period_idx
  on public.payroll_copilot_runs (year, month);

-- 2) Per-employee flags raised during a run (the "not green" ask-queue).
create table if not exists public.payroll_copilot_flags (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_copilot_runs (id) on delete cascade,
  employee_hr_id text not null,
  rule text not null,
  severity text not null default 'warn' check (severity in ('block', 'warn')),
  question text not null,
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  resolution jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payroll_copilot_flags_run_idx
  on public.payroll_copilot_flags (run_id);
create index if not exists payroll_copilot_flags_run_status_idx
  on public.payroll_copilot_flags (run_id, status);

-- 3) Manual / resolved adjustments applied to the draft (full audit of changes).
create table if not exists public.payroll_copilot_adjustments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_copilot_runs (id) on delete cascade,
  employee_hr_id text not null,
  kind text not null
    check (kind in ('bonus', 'penalty', 'loan', 'advance', 'prorate', 'override', 'include', 'defer')),
  amount numeric(20, 2) null,
  field text null,
  worked_days integer null,
  reason text null,
  recurring_id uuid null,
  source text not null default 'chat',
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists payroll_copilot_adjustments_run_idx
  on public.payroll_copilot_adjustments (run_id);
create index if not exists payroll_copilot_adjustments_employee_idx
  on public.payroll_copilot_adjustments (employee_hr_id);

-- 4) Cross-month recurring items (loans/advances/allowances that auto-apply).
create table if not exists public.payroll_recurring_adjustments (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  kind text not null check (kind in ('loan', 'advance', 'allowance', 'penalty')),
  monthly_amount numeric(20, 2) not null,
  remaining_installments integer null,
  start_month integer not null check (start_month between 1 and 12),
  start_year integer not null check (start_year between 2000 and 2100),
  active boolean not null default true,
  note text null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payroll_recurring_adjustments_employee_idx
  on public.payroll_recurring_adjustments (employee_hr_id);
create index if not exists payroll_recurring_adjustments_active_idx
  on public.payroll_recurring_adjustments (active)
  where active = true;

-- Link adjustments to their originating recurring item (added after both exist).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'payroll_copilot_adjustments_recurring_id_fkey'
      and table_name = 'payroll_copilot_adjustments'
  ) then
    alter table public.payroll_copilot_adjustments
      add constraint payroll_copilot_adjustments_recurring_id_fkey
      foreign key (recurring_id)
      references public.payroll_recurring_adjustments (id)
      on delete set null;
  end if;
end $$;

-- Enable RLS on all four tables.
alter table public.payroll_copilot_runs enable row level security;
alter table public.payroll_copilot_flags enable row level security;
alter table public.payroll_copilot_adjustments enable row level security;
alter table public.payroll_recurring_adjustments enable row level security;

-- RLS policies: mirror salary_batches — only admins that can manage employees.
-- SELECT + write are all gated by current_access_can_manage_employees().
do $$
declare
  tbl text;
  tables text[] := array[
    'payroll_copilot_runs',
    'payroll_copilot_flags',
    'payroll_copilot_adjustments',
    'payroll_recurring_adjustments'
  ];
begin
  foreach tbl in array tables loop
    execute format('drop policy if exists %I on public.%I;', tbl || '_admin_select', tbl);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_access_can_manage_employees());',
      tbl || '_admin_select', tbl
    );

    execute format('drop policy if exists %I on public.%I;', tbl || '_admin_insert', tbl);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.current_access_can_manage_employees());',
      tbl || '_admin_insert', tbl
    );

    execute format('drop policy if exists %I on public.%I;', tbl || '_admin_update', tbl);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.current_access_can_manage_employees()) with check (public.current_access_can_manage_employees());',
      tbl || '_admin_update', tbl
    );

    execute format('drop policy if exists %I on public.%I;', tbl || '_admin_delete', tbl);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.current_access_can_manage_employees());',
      tbl || '_admin_delete', tbl
    );
  end loop;
end $$;

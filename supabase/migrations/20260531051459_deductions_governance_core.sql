-- Deductions Governance Center foundation.
create table if not exists public.deduction_candidates (
  id uuid primary key default gen_random_uuid(),
  source_module text not null,
  source_record_id text not null,
  candidate_key text not null,
  employee_code text not null,
  employee_hr_id_compact text not null,
  employee_name text null,
  month_key text not null,
  month integer not null,
  year integer not null,
  deduction_type text not null,
  deduction_unit text not null,
  deduction_value numeric(14, 2) not null default 0,
  estimated_amount numeric(14, 2) null,
  calculation_status text not null default 'requires_payroll_review',
  severity text null,
  reason text null,
  evidence jsonb not null default '{}'::jsonb,
  holiday_context text null,
  dates jsonb not null default '[]'::jsonb,
  hierarchy_snapshot jsonb not null default '{}'::jsonb,
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  superseded_at timestamptz null,
  superseded_by_candidate_id uuid null references public.deduction_candidates(id) on delete set null,
  constraint deduction_candidates_source_module_check check (source_module in (
    'FIELD_WORKFORCE',
    'ATTENDANCE_DEVICE',
    'VACATION',
    'MANUAL_HR',
    'DISCIPLINARY',
    'PAYROLL_ADJUSTMENT',
    'EXPENSE_RECOVERY',
    'OTHER'
  )),
  constraint deduction_candidates_month_range check (month between 1 and 12),
  constraint deduction_candidates_year_range check (year between 2000 and 2100),
  constraint deduction_candidates_deduction_type_check check (deduction_type in (
    'no_activity',
    'absence',
    'late_arrival',
    'early_leave',
    'missing_punch',
    'unpaid_leave',
    'leave_without_balance',
    'retroactive_leave',
    'disciplinary_deduction',
    'manual_deduction',
    'expense_recovery',
    'salary_adjustment',
    'other'
  )),
  constraint deduction_candidates_deduction_unit_check check (deduction_unit in (
    'days',
    'hours',
    'amount',
    'count',
    'percentage'
  )),
  constraint deduction_candidates_deduction_value_non_negative check (deduction_value >= 0),
  constraint deduction_candidates_calculation_status_check check (calculation_status in (
    'calculated',
    'requires_payroll_formula',
    'requires_payroll_review',
    'not_applicable'
  )),
  constraint deduction_candidates_severity_check check (severity is null or severity in (
    'Low',
    'Medium',
    'High',
    'Review'
  )),
  constraint deduction_candidates_source_record_id_not_blank check (btrim(source_record_id) <> ''),
  constraint deduction_candidates_candidate_key_not_blank check (btrim(candidate_key) <> ''),
  constraint deduction_candidates_employee_code_not_blank check (btrim(employee_code) <> ''),
  constraint deduction_candidates_employee_hr_id_compact_not_blank check (btrim(employee_hr_id_compact) <> ''),
  constraint deduction_candidates_month_key_not_blank check (btrim(month_key) <> '')
);

create unique index if not exists deduction_candidates_live_key_uidx
  on public.deduction_candidates (source_module, candidate_key)
  where superseded_at is null;

create index if not exists deduction_candidates_employee_code_idx
  on public.deduction_candidates (employee_code);

create index if not exists deduction_candidates_employee_hr_id_compact_idx
  on public.deduction_candidates (employee_hr_id_compact);

create index if not exists deduction_candidates_month_key_idx
  on public.deduction_candidates (month_key);

create index if not exists deduction_candidates_source_module_month_idx
  on public.deduction_candidates (source_module, month_key);

create index if not exists deduction_candidates_dates_gin_idx
  on public.deduction_candidates using gin (dates jsonb_path_ops);

create table if not exists public.deduction_decisions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.deduction_candidates(id) on delete cascade,
  decision_status text not null default 'Pending',
  decision_reason text not null default '',
  hr_note text not null default '',
  decided_by text null,
  decided_at timestamptz null,
  resolved_at timestamptz null,
  resolved_by text null,
  payroll_handoff_status text not null default 'Not pushed',
  last_export_id uuid null,
  actor_role_at_decision text null,
  actor_scope_at_decision text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deduction_decisions_status_check check (decision_status in (
    'Pending',
    'Approved for Payroll',
    'Approved for Leave Adjustment',
    'Do Not Take Action',
    'Needs Follow-up',
    'Disputed',
    'Resolved',
    'Cancelled'
  )),
  constraint deduction_decisions_payroll_handoff_status_check check (payroll_handoff_status in (
    'Not pushed',
    'Export only',
    'Pending integration'
  )),
  constraint deduction_decisions_reason_required_when_decided check (
    decision_status = 'Pending' or btrim(decision_reason) <> ''
  ),
  constraint deduction_decisions_candidate_unique unique (candidate_id)
);

create index if not exists deduction_decisions_candidate_id_idx
  on public.deduction_decisions (candidate_id);

create index if not exists deduction_decisions_decision_status_idx
  on public.deduction_decisions (decision_status);

create index if not exists deduction_decisions_payroll_handoff_status_idx
  on public.deduction_decisions (payroll_handoff_status);

create table if not exists public.deduction_exports (
  id uuid primary key default gen_random_uuid(),
  month_key text null,
  generated_by text not null,
  generated_at timestamptz not null default now(),
  decision_count integer not null default 0,
  filters_snapshot jsonb not null default '{}'::jsonb,
  file_name text not null,
  notes text null,
  constraint deduction_exports_generated_by_not_blank check (btrim(generated_by) <> ''),
  constraint deduction_exports_file_name_not_blank check (btrim(file_name) <> ''),
  constraint deduction_exports_decision_count_non_negative check (decision_count >= 0)
);

create index if not exists deduction_exports_month_key_generated_at_idx
  on public.deduction_exports (month_key, generated_at desc);

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'deduction_decisions'
      and constraint_name = 'deduction_decisions_last_export_id_fkey'
  ) then
    alter table public.deduction_decisions
      add constraint deduction_decisions_last_export_id_fkey
      foreign key (last_export_id)
      references public.deduction_exports(id)
      on delete set null;
  end if;
end
$$;

create or replace function public.phx_touch_deduction_decisions()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.phx_touch_deduction_decisions() from public, anon, authenticated;
grant execute on function public.phx_touch_deduction_decisions() to service_role;

drop trigger if exists deduction_decisions_touch on public.deduction_decisions;
create trigger deduction_decisions_touch
  before update on public.deduction_decisions
  for each row
  execute function public.phx_touch_deduction_decisions();

alter table public.deduction_candidates enable row level security;
alter table public.deduction_decisions enable row level security;
alter table public.deduction_exports enable row level security;

revoke all on table public.deduction_candidates from anon, authenticated;
revoke all on table public.deduction_decisions from anon, authenticated;
revoke all on table public.deduction_exports from anon, authenticated;

grant select, insert, update, delete on table public.deduction_candidates to service_role;
grant select, insert, update, delete on table public.deduction_decisions to service_role;
grant select, insert, update, delete on table public.deduction_exports to service_role;

drop policy if exists deduction_candidates_service_role_all
  on public.deduction_candidates;
create policy deduction_candidates_service_role_all
  on public.deduction_candidates
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists deduction_decisions_service_role_all
  on public.deduction_decisions;
create policy deduction_decisions_service_role_all
  on public.deduction_decisions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists deduction_exports_service_role_all
  on public.deduction_exports;
create policy deduction_exports_service_role_all
  on public.deduction_exports
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.deduction_candidates is
  'Deductions Governance Center: deduction candidates from source modules. Governance/reporting only. No trigger or application path may auto-mutate payroll (salary_records) or employee leave balances from this table.';

comment on table public.deduction_decisions is
  'Deductions Governance Center: HR review decisions per candidate. Export-only handoff. No auto-execution.';

comment on table public.deduction_exports is
  'Deductions Governance Center: registry of payroll handoff workbooks generated by HR. Audit/chain-of-custody only.';

comment on column public.deduction_candidates.estimated_amount is
  'Nullable. Source modules MUST leave NULL if a safe payroll formula is not available.';

comment on column public.deduction_decisions.payroll_handoff_status is
  'Export-only by design; never executes payroll.';;

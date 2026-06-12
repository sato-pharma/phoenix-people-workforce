-- Double Visit Analytics.
-- Reporting/evidence only: these tables do not mutate attendance, leave,
-- deductions, payroll, or Field Workforce Compliance decisions.

create table if not exists public.double_visit_imports (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_filename text not null,
  sheet_name text null,
  date_from date not null,
  date_to date not null,
  status text not null default 'preview',
  total_rows integer not null default 0,
  total_visits integer not null default 0,
  active_mapped_visit_count integer not null default 0,
  vacant_or_unmapped_visit_count integer not null default 0,
  am_visit_count integer not null default 0,
  pm_visit_count integer not null default 0,
  double_visitor_count integer not null default 0,
  mr_coverage_count integer not null default 0,
  area_count integer not null default 0,
  line_count integer not null default 0,
  warning_count integer not null default 0,
  duplicate_warning_count integer not null default 0,
  missing_visited_hr_id_count integer not null default 0,
  validation_summary jsonb not null default '{}'::jsonb,
  uploaded_by text not null default 'system',
  uploaded_at timestamptz not null default now(),
  published_by text null,
  published_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint double_visit_imports_source_type_check
    check (source_type in ('excel', 'ireports360')),
  constraint double_visit_imports_status_check
    check (status in ('preview', 'published', 'superseded', 'archived')),
  constraint double_visit_imports_date_range_check
    check (date_to >= date_from),
  constraint double_visit_imports_count_check
    check (
      total_rows >= 0
      and total_visits >= 0
      and active_mapped_visit_count >= 0
      and vacant_or_unmapped_visit_count >= 0
      and am_visit_count >= 0
      and pm_visit_count >= 0
    )
);

create table if not exists public.double_visit_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.double_visit_imports(id) on delete cascade,
  source_type text not null,
  source_row_number integer null,
  source_record_id text null,
  source_hash text not null,
  double_visitor_name text null,
  double_visitor_hr_id text null,
  visited_employee_name text null,
  visited_employee_hr_id text null,
  visited_employee_status text not null default 'unmapped',
  activity_date date not null,
  visit_count integer not null default 0,
  period text not null default 'UNKNOWN',
  area_name text null,
  line_name text null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint double_visit_rows_source_type_check
    check (source_type in ('excel', 'ireports360')),
  constraint double_visit_rows_period_check
    check (period in ('AM', 'PM', 'UNKNOWN')),
  constraint double_visit_rows_status_check
    check (visited_employee_status in ('active_mapped', 'blank_hr_id', 'vacant', 'resigned', 'unmapped')),
  constraint double_visit_rows_visit_count_check
    check (visit_count >= 0),
  constraint double_visit_rows_import_hash_unique unique (import_id, source_hash)
);

create index if not exists double_visit_imports_status_dates_idx
  on public.double_visit_imports (status, date_from, date_to, uploaded_at desc);

create index if not exists double_visit_rows_import_date_idx
  on public.double_visit_rows (import_id, activity_date);

create index if not exists double_visit_rows_double_visitor_idx
  on public.double_visit_rows (double_visitor_hr_id, activity_date);

create index if not exists double_visit_rows_visited_employee_idx
  on public.double_visit_rows (visited_employee_hr_id, activity_date);

create index if not exists double_visit_rows_area_line_idx
  on public.double_visit_rows (area_name, line_name);

alter table public.double_visit_imports enable row level security;
alter table public.double_visit_rows enable row level security;

revoke all on table public.double_visit_imports from anon, authenticated;
revoke all on table public.double_visit_rows from anon, authenticated;

grant select, insert, update, delete on table public.double_visit_imports to service_role;
grant select, insert, update, delete on table public.double_visit_rows to service_role;

drop policy if exists double_visit_imports_service_role on public.double_visit_imports;
create policy double_visit_imports_service_role
  on public.double_visit_imports
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists double_visit_rows_service_role on public.double_visit_rows;
create policy double_visit_rows_service_role
  on public.double_visit_rows
  for all
  to service_role
  using (true)
  with check (true);

alter table public.outstation_expense_requests
  add column if not exists workload_source text not null default 'manual',
  add column if not exists workload_source_import_id uuid null references public.double_visit_imports(id) on delete set null,
  add column if not exists workload_match_status text not null default 'manual',
  add column if not exists workload_matched_at timestamptz null,
  add column if not exists workload_override_reason text null,
  add column if not exists workload_evidence_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'outstation_workload_source_check'
      and conrelid = 'public.outstation_expense_requests'::regclass
  ) then
    alter table public.outstation_expense_requests
      add constraint outstation_workload_source_check
      check (workload_source in ('manual', 'double_visit_import', 'ireports360', 'override'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'outstation_workload_match_status_check'
      and conrelid = 'public.outstation_expense_requests'::regclass
  ) then
    alter table public.outstation_expense_requests
      add constraint outstation_workload_match_status_check
      check (workload_match_status in ('manual', 'matched', 'partial', 'no_activity', 'manual_override', 'stale_import'));
  end if;
end $$;

create index if not exists outstation_expense_workload_source_idx
  on public.outstation_expense_requests (workload_source, workload_match_status);

comment on table public.double_visit_imports is
  'Double Visit Analytics import snapshots. Reporting/evidence only; publishing chooses the official snapshot for dashboards and expense workload evidence.';

comment on table public.double_visit_rows is
  'Raw normalized double visit rows from Excel or iReports360. Vacant, resigned, blank, and unmapped visited employees are preserved and still count toward double visitor effort.';

comment on column public.double_visit_rows.double_visitor_hr_id is
  'The person credited for the double visit. Expense workload matching uses this value.';

comment on column public.double_visit_rows.visited_employee_status is
  'Mapping status of the visited employee only. This never controls whether double visitor effort counts.';

comment on column public.outstation_expense_requests.workload_evidence_snapshot is
  'Frozen AM/PM workload evidence from Double Visit Analytics at submission/update time.';

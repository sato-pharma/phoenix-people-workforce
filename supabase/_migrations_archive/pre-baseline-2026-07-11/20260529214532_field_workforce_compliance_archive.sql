-- Field Workforce Compliance Phase 2 archive.
--
-- Scope:
-- - Persist validated monthly archive snapshots.
-- - Store normalized employee/day rows and monthly employee summaries.
-- - Keep payroll and leave actions out of scope. This schema is archive and
--   historical review only.
--
-- Security model:
-- Phoenix uses application-managed auth and service-role server APIs for admin
-- workflows. These tables are not exposed directly to anon/authenticated
-- clients. RLS is enabled as defense in depth with service_role-only policies.

create table if not exists public.field_workforce_compliance_imports (
  id uuid primary key default gen_random_uuid(),
  month_key text not null,
  month integer not null,
  year integer not null,
  source_filename text not null,
  sheet_name text not null,
  uploaded_by text not null default 'system',
  uploaded_at timestamptz not null default now(),
  employee_count integer not null default 0,
  review_candidate_count integer not null default 0,
  high_severity_count integer not null default 0,
  status text not null default 'archived',
  validation_summary jsonb not null default '{}'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint field_workforce_imports_month_range check (month between 1 and 12),
  constraint field_workforce_imports_year_range check (year between 2000 and 2100),
  constraint field_workforce_imports_status_check check (status in ('archived', 'superseded')),
  constraint field_workforce_imports_month_key_not_blank check (btrim(month_key) <> ''),
  constraint field_workforce_imports_source_filename_not_blank check (btrim(source_filename) <> ''),
  constraint field_workforce_imports_sheet_name_not_blank check (btrim(sheet_name) <> ''),
  constraint field_workforce_imports_employee_count_non_negative check (employee_count >= 0),
  constraint field_workforce_imports_review_count_non_negative check (review_candidate_count >= 0),
  constraint field_workforce_imports_high_count_non_negative check (high_severity_count >= 0)
);
create unique index if not exists field_workforce_imports_archived_month_key_uidx
  on public.field_workforce_compliance_imports (month_key)
  where status = 'archived';
create index if not exists field_workforce_imports_uploaded_at_idx
  on public.field_workforce_compliance_imports (uploaded_at desc);
create index if not exists field_workforce_imports_period_idx
  on public.field_workforce_compliance_imports (year desc, month desc, uploaded_at desc);
create table if not exists public.field_workforce_compliance_days (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.field_workforce_compliance_imports(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  hiring_date date null,
  activity_date date not null,
  day_number integer not null,
  raw_value jsonb null,
  normalized_status text not null,
  visit_count numeric(12, 2) null,
  is_pre_hire boolean not null default false,
  is_friday boolean not null default false,
  is_public_holiday boolean not null default false,
  public_holiday_name text null,
  counted_as_worked_day boolean not null default false,
  counted_as_visit_total boolean not null default false,
  counted_as_no_activity_candidate boolean not null default false,
  ignored boolean not null default false,
  ignore_reason text null,
  severity text null,
  explanation text not null,
  created_at timestamptz not null default now(),
  constraint field_workforce_days_day_number_range check (day_number between 1 and 31),
  constraint field_workforce_days_employee_code_not_blank check (btrim(employee_code) <> ''),
  constraint field_workforce_days_employee_name_not_blank check (btrim(employee_name) <> ''),
  constraint field_workforce_days_status_check check (normalized_status in ('N', 'AV', 'CP', 'VISITS', 'F', 'BLANK', 'UNKNOWN')),
  constraint field_workforce_days_severity_check check (severity is null or severity in ('Low', 'Medium', 'High', 'Review')),
  constraint field_workforce_days_ignore_reason_check check (ignore_reason is null or ignore_reason in ('before_hiring_date', 'friday'))
);
create index if not exists field_workforce_days_import_employee_date_idx
  on public.field_workforce_compliance_days (import_id, employee_code, activity_date);
create index if not exists field_workforce_days_import_id_idx
  on public.field_workforce_compliance_days (import_id);
create index if not exists field_workforce_days_employee_idx
  on public.field_workforce_compliance_days (employee_code, activity_date);
create index if not exists field_workforce_days_status_idx
  on public.field_workforce_compliance_days (import_id, normalized_status);
create index if not exists field_workforce_days_severity_idx
  on public.field_workforce_compliance_days (import_id, severity);
create table if not exists public.field_workforce_compliance_monthly_summary (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.field_workforce_compliance_imports(id) on delete cascade,
  month_key text not null,
  employee_code text not null,
  employee_name text not null,
  hiring_date date null,
  month_working_days integer not null default 0,
  employee_eligible_working_days integer not null default 0,
  worked_days integer not null default 0,
  no_activity_days integer not null default 0,
  vacation_days integer not null default 0,
  fridays integer not null default 0,
  campaign_days integer not null default 0,
  total_visits numeric(14, 2) not null default 0,
  no_activity_dates jsonb not null default '[]'::jsonb,
  public_holiday_warning_count integer not null default 0,
  high_severity_count integer not null default 0,
  review_candidate_count integer not null default 0,
  compliance_percent numeric(6, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint field_workforce_summary_month_key_not_blank check (btrim(month_key) <> ''),
  constraint field_workforce_summary_employee_code_not_blank check (btrim(employee_code) <> ''),
  constraint field_workforce_summary_employee_name_not_blank check (btrim(employee_name) <> ''),
  constraint field_workforce_summary_month_days_non_negative check (month_working_days >= 0),
  constraint field_workforce_summary_eligible_days_non_negative check (employee_eligible_working_days >= 0),
  constraint field_workforce_summary_worked_days_non_negative check (worked_days >= 0),
  constraint field_workforce_summary_no_activity_non_negative check (no_activity_days >= 0),
  constraint field_workforce_summary_vacation_non_negative check (vacation_days >= 0),
  constraint field_workforce_summary_fridays_non_negative check (fridays >= 0),
  constraint field_workforce_summary_campaign_non_negative check (campaign_days >= 0),
  constraint field_workforce_summary_visits_non_negative check (total_visits >= 0),
  constraint field_workforce_summary_holiday_warnings_non_negative check (public_holiday_warning_count >= 0),
  constraint field_workforce_summary_high_count_non_negative check (high_severity_count >= 0),
  constraint field_workforce_summary_review_count_non_negative check (review_candidate_count >= 0),
  constraint field_workforce_summary_compliance_percent_range check (compliance_percent between 0 and 100)
);
create index if not exists field_workforce_summary_import_employee_idx
  on public.field_workforce_compliance_monthly_summary (import_id, employee_code);
create index if not exists field_workforce_summary_month_key_idx
  on public.field_workforce_compliance_monthly_summary (month_key, employee_code);
create index if not exists field_workforce_summary_import_id_idx
  on public.field_workforce_compliance_monthly_summary (import_id);
alter table public.field_workforce_compliance_imports enable row level security;
alter table public.field_workforce_compliance_days enable row level security;
alter table public.field_workforce_compliance_monthly_summary enable row level security;
revoke all on table public.field_workforce_compliance_imports from anon, authenticated;
revoke all on table public.field_workforce_compliance_days from anon, authenticated;
revoke all on table public.field_workforce_compliance_monthly_summary from anon, authenticated;
grant select, insert, update, delete on table public.field_workforce_compliance_imports to service_role;
grant select, insert, update, delete on table public.field_workforce_compliance_days to service_role;
grant select, insert, update, delete on table public.field_workforce_compliance_monthly_summary to service_role;
drop policy if exists field_workforce_imports_service_role_all
  on public.field_workforce_compliance_imports;
create policy field_workforce_imports_service_role_all
  on public.field_workforce_compliance_imports
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists field_workforce_days_service_role_all
  on public.field_workforce_compliance_days;
create policy field_workforce_days_service_role_all
  on public.field_workforce_compliance_days
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists field_workforce_summary_service_role_all
  on public.field_workforce_compliance_monthly_summary;
create policy field_workforce_summary_service_role_all
  on public.field_workforce_compliance_monthly_summary
  for all
  to service_role
  using (true)
  with check (true);
comment on table public.field_workforce_compliance_imports is
  'Monthly Field Workforce Compliance archive metadata. Archive/review only; no payroll or leave mutation.';
comment on table public.field_workforce_compliance_days is
  'Normalized day-by-day Field Workforce Compliance archive rows. Values are recommendations/context only.';
comment on table public.field_workforce_compliance_monthly_summary is
  'Monthly employee summary snapshot for Field Workforce Compliance archives.';

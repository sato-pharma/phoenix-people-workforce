create table if not exists public.sales_import_batches (
  id uuid primary key,
  file_name text not null,
  line text not null,
  month integer not null check (month between 1 and 12),
  year integer not null check (year >= 2000),
  period text not null,
  status text not null default 'staged',
  schema_type text not null default 'raw_sales',
  total_records integer not null default 0,
  valid_records integer not null default 0,
  warning_records integer not null default 0,
  failed_records integer not null default 0,
  linked_records integer not null default 0,
  linkage_rate numeric not null default 0,
  uploaded_by text not null default 'system',
  version integer not null default 1,
  duplicate_hash text not null default '',
  is_duplicate boolean not null default false,
  replacement_for_batch_id uuid null,
  replaced_by_batch_id uuid null,
  approved_by text null,
  approved_at timestamptz null,
  rejected_by text null,
  rejected_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_records (
  id bigserial primary key,
  batch_id uuid not null references public.sales_import_batches(id) on delete cascade,
  row_number integer not null,
  employee_hr_id text null,
  employee_crm_id text null,
  employee_lookup_key text null,
  employee_name text null,
  manager_hr_id text null,
  line text not null,
  territory text not null,
  sales_type text not null,
  family text not null,
  product text not null,
  factory_price numeric not null default 0,
  month integer not null check (month between 1 and 12),
  year integer not null check (year >= 2000),
  sales_units numeric not null default 0,
  sales_value numeric not null default 0,
  target_units numeric not null default 0,
  target_value numeric not null default 0,
  validation_state text not null default 'valid',
  validation_notes jsonb not null default '[]'::jsonb,
  link_status text not null default 'unlinked',
  link_confidence numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_target_batches (
  id uuid primary key,
  file_name text not null,
  month integer not null check (month between 1 and 12),
  year integer not null check (year >= 2000),
  status text not null default 'uploaded',
  total_records integer not null default 0,
  valid_records integer not null default 0,
  failed_records integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_targets (
  id bigserial primary key,
  batch_id uuid not null references public.sales_target_batches(id) on delete cascade,
  employee_hr_id text null,
  employee_crm_id text null,
  employee_lookup_key text null,
  employee_name text null,
  manager_hr_id text null,
  line text not null,
  month integer not null check (month between 1 and 12),
  year integer not null check (year >= 2000),
  target_units numeric not null default 0,
  target_value numeric not null default 0,
  status text not null default 'valid',
  validation_notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_audit_logs (
  id bigserial primary key,
  action text not null,
  batch_id uuid null,
  actor_username text null,
  actor_display_name text null,
  line text null,
  period text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists public.sales_records
  add column if not exists manager_hr_id text;

alter table if exists public.sales_targets
  add column if not exists manager_hr_id text;

create index if not exists idx_sales_import_batches_status_period
  on public.sales_import_batches(status, year, month);

create index if not exists idx_sales_import_batches_duplicate_hash
  on public.sales_import_batches(duplicate_hash);

create index if not exists idx_sales_records_batch_id
  on public.sales_records(batch_id);

create index if not exists idx_sales_records_manager_hr_id
  on public.sales_records(manager_hr_id);

create index if not exists idx_sales_records_employee_hr_id
  on public.sales_records(employee_hr_id);

create index if not exists idx_sales_records_period
  on public.sales_records(year, month);

create index if not exists idx_sales_target_batches_period
  on public.sales_target_batches(year, month);

create index if not exists idx_sales_targets_batch_id
  on public.sales_targets(batch_id);

create index if not exists idx_sales_audit_logs_batch_id
  on public.sales_audit_logs(batch_id);

notify pgrst, 'reload schema';

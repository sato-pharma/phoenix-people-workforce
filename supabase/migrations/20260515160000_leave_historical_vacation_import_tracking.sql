-- Historical vacation import tracking only.
-- Do not apply automatically from Codex. Apply through the controlled Supabase migration process after review.

create table if not exists public.leave_historical_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_filename text not null,
  status text not null default 'confirmed' check (status in ('dry_run', 'confirmed', 'failed')),
  uploaded_by_hr_id text,
  uploaded_by_role text,
  total_rows integer not null default 0 check (total_rows >= 0),
  accepted_rows integer not null default 0 check (accepted_rows >= 0),
  rejected_rows integer not null default 0 check (rejected_rows >= 0),
  duplicate_rows integer not null default 0 check (duplicate_rows >= 0),
  affected_employees integer not null default 0 check (affected_employees >= 0),
  metadata jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.leave_historical_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.leave_historical_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  row_status text not null check (row_status in ('accepted', 'rejected', 'duplicate', 'imported')),
  employee_hr_id text,
  external_reference text,
  legacy_system text,
  leave_request_id uuid references public.leave_requests(id) on delete set null,
  validation_errors text[] not null default '{}',
  warnings text[] not null default '{}',
  row_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_leave_historical_import_batches_created_at
  on public.leave_historical_import_batches(created_at desc);

create index if not exists idx_leave_historical_import_rows_batch
  on public.leave_historical_import_rows(batch_id, row_number);

create index if not exists idx_leave_historical_import_rows_employee
  on public.leave_historical_import_rows(employee_hr_id);

create unique index if not exists uq_leave_historical_import_external_ref
  on public.leave_historical_import_rows(employee_hr_id, legacy_system, external_reference)
  where external_reference is not null and employee_hr_id is not null;

alter table public.leave_historical_import_batches enable row level security;
alter table public.leave_historical_import_rows enable row level security;

revoke all on public.leave_historical_import_batches from anon, authenticated;
revoke all on public.leave_historical_import_rows from anon, authenticated;

create policy "Service role can manage historical import batches"
  on public.leave_historical_import_batches
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Service role can manage historical import rows"
  on public.leave_historical_import_rows
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

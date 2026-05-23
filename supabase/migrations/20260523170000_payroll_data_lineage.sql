-- P1-06: structured lineage row for every payroll write path.
-- One row per write-batch call (not per row) in:
--   create_batch, replace_batch, workflow_transition,
--   save_expenses, import_expenses, set_approval, decide_approval

create table if not exists public.payroll_data_lineage (
  id               uuid        primary key default gen_random_uuid(),
  payroll_batch_id uuid        references public.salary_batches(id) on delete set null,
  import_job_id    uuid,       -- soft ref to payroll_import_jobs.import_job_id (no FK for perf)
  actor_id         text        not null default 'system',
  request_id       uuid,       -- optional correlation ID supplied by the caller
  source_file_name text        not null default '',
  operation        text        not null
                               check (operation in (
                                 'create_batch',
                                 'replace_batch',
                                 'workflow_transition',
                                 'save_expenses',
                                 'import_expenses',
                                 'set_approval',
                                 'decide_approval'
                               )),
  entity_type      text        not null default 'payroll_batch',
  entity_id        text,       -- batch_id, trip_id, or similar
  payload_hash     text,       -- sha-256 hex of the serialised write payload
  meta             jsonb,      -- action, row_count, or other op-specific details
  created_at       timestamptz not null default now()
);

create index if not exists payroll_data_lineage_batch_id_idx
  on public.payroll_data_lineage (payroll_batch_id);

create index if not exists payroll_data_lineage_import_job_id_idx
  on public.payroll_data_lineage (import_job_id)
  where import_job_id is not null;

create index if not exists payroll_data_lineage_created_at_idx
  on public.payroll_data_lineage (created_at desc);

alter table public.payroll_data_lineage enable row level security;
revoke all on table public.payroll_data_lineage from public, anon, authenticated;
grant all on table public.payroll_data_lineage to service_role;

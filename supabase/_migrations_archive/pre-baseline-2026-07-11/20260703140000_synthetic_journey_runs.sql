create table if not exists public.synthetic_journey_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  base_url text not null,
  environment text,
  overall_status text not null check (overall_status in ('healthy', 'warning', 'failed', 'no_data')),
  total_count int not null default 0,
  passed_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  duration_ms int not null default 0,
  report_json jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);

comment on table public.synthetic_journey_runs is
  'One row per Synthetic User Journeys smoke-test run (npm run synthetic:test). Read-only admin dashboard data - no PII, no credentials, no payroll data. Ingested via scripts/synthetic-save-report.ts or POST /api/admin/synthetic-journeys/ingest.';

create index if not exists synthetic_journey_runs_created_at_idx
  on public.synthetic_journey_runs (created_at desc);

alter table public.synthetic_journey_runs enable row level security;

revoke all on public.synthetic_journey_runs from anon, authenticated;
grant select, insert on public.synthetic_journey_runs to service_role;

drop policy if exists "synthetic journey runs service role access" on public.synthetic_journey_runs;
create policy "synthetic journey runs service role access"
  on public.synthetic_journey_runs
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.synthetic_journey_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.synthetic_journey_runs(id) on delete cascade,
  journey_id text not null,
  journey_name text not null,
  route text not null,
  status text not null check (status in ('passed', 'failed', 'skipped')),
  duration_ms int not null default 0,
  failure_reason text,
  recommendation text,
  screenshot_path text,
  trace_path text,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.synthetic_journey_results is
  'One row per journey within a synthetic_journey_runs run. Read-only smoke-test evidence only - no PII, no credentials, no payroll data.';

create index if not exists synthetic_journey_results_run_id_idx
  on public.synthetic_journey_results (run_id);

alter table public.synthetic_journey_results enable row level security;

revoke all on public.synthetic_journey_results from anon, authenticated;
grant select, insert on public.synthetic_journey_results to service_role;

drop policy if exists "synthetic journey results service role access" on public.synthetic_journey_results;
create policy "synthetic journey results service role access"
  on public.synthetic_journey_results
  for all
  to service_role
  using (true)
  with check (true);

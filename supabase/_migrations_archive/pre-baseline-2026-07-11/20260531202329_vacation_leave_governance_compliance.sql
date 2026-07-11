-- Vacation leave governance and compliance hardening.
-- Additive-only schema for retention metadata, governed purge dry-runs, and
-- persistent API rate limiting. Runtime purge execution remains service-only.

begin;
create table if not exists public.api_rate_limit_buckets (
  bucket_key text primary key,
  request_count integer not null default 0,
  reset_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_rate_limit_buckets_count_check check (request_count >= 0)
);
create index if not exists api_rate_limit_buckets_reset_idx
  on public.api_rate_limit_buckets (reset_at);
create table if not exists public.v2_vacation_retention_policies (
  policy_key text primary key,
  retention_days integer not null,
  description text not null,
  purge_mode text not null default 'manual_approval_required',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_retention_policies_days_check check (retention_days > 0),
  constraint v2_vacation_retention_policies_mode_check check (purge_mode in ('dry_run_only', 'manual_approval_required'))
);
insert into public.v2_vacation_retention_policies (policy_key, retention_days, description, purge_mode)
values
  ('request_history', 2555, 'Keep leave requests, request events, and core audit history for seven years.', 'manual_approval_required'),
  ('evidence_attachments', 1095, 'Keep leave evidence attachments for three years after final decision.', 'manual_approval_required'),
  ('decision_tokens', 90, 'Keep vacation email approval tokens for ninety days.', 'manual_approval_required'),
  ('sla_run_logs', 365, 'Keep vacation SLA run logs for one year.', 'manual_approval_required')
on conflict (policy_key) do update
set retention_days = excluded.retention_days,
    description = excluded.description,
    purge_mode = excluded.purge_mode,
    updated_at = now();
create table if not exists public.v2_vacation_retention_purge_runs (
  id uuid primary key default gen_random_uuid(),
  actor_login_id text null,
  dry_run boolean not null default true,
  policy_snapshot jsonb not null default '{}'::jsonb,
  candidates jsonb not null default '{}'::jsonb,
  deleted_counts jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running',
  constraint v2_vacation_retention_purge_runs_status_check check (status in ('running', 'completed', 'failed'))
);
create index if not exists v2_vacation_retention_purge_runs_started_idx
  on public.v2_vacation_retention_purge_runs (started_at desc);
alter table public.api_rate_limit_buckets enable row level security;
alter table public.v2_vacation_retention_policies enable row level security;
alter table public.v2_vacation_retention_purge_runs enable row level security;
revoke all on table public.api_rate_limit_buckets from anon, authenticated;
revoke all on table public.v2_vacation_retention_policies from anon, authenticated;
revoke all on table public.v2_vacation_retention_purge_runs from anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limit_buckets to service_role;
grant select on table public.v2_vacation_retention_policies to service_role;
grant select, insert, update on table public.v2_vacation_retention_purge_runs to service_role;
drop policy if exists api_rate_limit_buckets_service_role_all on public.api_rate_limit_buckets;
create policy api_rate_limit_buckets_service_role_all
  on public.api_rate_limit_buckets
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists v2_vacation_retention_policies_service_role_read on public.v2_vacation_retention_policies;
create policy v2_vacation_retention_policies_service_role_read
  on public.v2_vacation_retention_policies
  for select
  to service_role
  using (true);
drop policy if exists v2_vacation_retention_purge_runs_service_role_all on public.v2_vacation_retention_purge_runs;
create policy v2_vacation_retention_purge_runs_service_role_all
  on public.v2_vacation_retention_purge_runs
  for all
  to service_role
  using (true)
  with check (true);
notify pgrst, 'reload schema';
commit;

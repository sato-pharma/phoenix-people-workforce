-- Monthly Sales guided workflow — resumable run state + period lock. A "run" tracks one period's
-- guided close (distributor-by-distributor: pending → uploaded → validated → confirmed, or skipped),
-- and a period lock freezes the period once the close is finalized. Additive + reversible.

-- 1. One run per period.
create table if not exists public.monthly_sales_run (
  id uuid primary key default gen_random_uuid(),
  period text not null,
  status text not null default 'in_progress',
  created_by text not null default 'system',
  locked_by text null,
  locked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_sales_run_period_format check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint monthly_sales_run_status_check check (status in ('in_progress', 'locked', 'reopened')),
  constraint monthly_sales_run_period_unique unique (period)
);

-- 2. One step per (run, distributor).
create table if not exists public.monthly_sales_run_step (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.monthly_sales_run(id) on delete cascade,
  distributor_code text not null references public.source_of_sales_distributors(distributor_code),
  step_status text not null default 'pending',
  skip_reason text null,
  batch_id uuid null references public.source_of_sales_import_batches(id) on delete set null,
  weight numeric(8, 6) not null default 0,
  ordering integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint monthly_sales_run_step_status_check
    check (step_status in ('pending', 'uploaded', 'validated', 'confirmed', 'skipped')),
  constraint monthly_sales_run_step_skip_reason_required
    check (step_status <> 'skipped' or btrim(coalesce(skip_reason, '')) <> ''),
  constraint monthly_sales_run_step_unique unique (run_id, distributor_code)
);

-- 3. Period lock — the cheap enforcement surface the import service checks.
create table if not exists public.monthly_sales_period_lock (
  period text primary key,
  locked boolean not null default true,
  locked_by text null,
  locked_at timestamptz not null default now(),
  reopened_by text null,
  reopened_at timestamptz null,
  constraint monthly_sales_period_lock_format check (period ~ '^[0-9]{4}-[0-9]{2}$')
);

create index if not exists monthly_sales_run_step_run_ordering_idx
  on public.monthly_sales_run_step (run_id, ordering);
create index if not exists monthly_sales_run_step_batch_idx
  on public.monthly_sales_run_step (batch_id);

-- RLS: server/service-role only (all access goes through getSupabaseAdmin()).
alter table public.monthly_sales_run enable row level security;
alter table public.monthly_sales_run_step enable row level security;
alter table public.monthly_sales_period_lock enable row level security;

revoke all on table public.monthly_sales_run from anon, authenticated;
revoke all on table public.monthly_sales_run_step from anon, authenticated;
revoke all on table public.monthly_sales_period_lock from anon, authenticated;

grant select, insert, update, delete on table public.monthly_sales_run to service_role;
grant select, insert, update, delete on table public.monthly_sales_run_step to service_role;
grant select, insert, update, delete on table public.monthly_sales_period_lock to service_role;

drop policy if exists monthly_sales_run_service_role_all on public.monthly_sales_run;
create policy monthly_sales_run_service_role_all
on public.monthly_sales_run
for all
to service_role
using (true)
with check (true);

drop policy if exists monthly_sales_run_step_service_role_all on public.monthly_sales_run_step;
create policy monthly_sales_run_step_service_role_all
on public.monthly_sales_run_step
for all
to service_role
using (true)
with check (true);

drop policy if exists monthly_sales_period_lock_service_role_all on public.monthly_sales_period_lock;
create policy monthly_sales_period_lock_service_role_all
on public.monthly_sales_period_lock
for all
to service_role
using (true)
with check (true);

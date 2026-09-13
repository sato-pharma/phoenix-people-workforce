-- Make It Happen — saved forecast plans (owner request 2026-09-13).
--
-- A sales employee types forecast units per concentration for a month, quarter or semester and
-- saves the plan. One row per saved plan; `units` maps product_code -> whole units. The value and
-- achievement are snapshots computed server-side at save time (units x factory price, graded actual
-- over target) so a manager reading the plan later sees what the planner saw.
--
-- Service-role only, the Market Awareness convention: every read and write goes through
-- src/lib/sales/make-it-happen/, which decides scope first. No browser role can touch the table.

create table if not exists public.sales_forecast_plans (
  id uuid primary key default gen_random_uuid(),
  owner_hr_id text not null check (char_length(btrim(owner_hr_id)) > 0),
  period_kind text not null check (period_kind in ('month', 'quarter', 'semester')),
  period_key text not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  units jsonb not null default '{}'::jsonb check (jsonb_typeof(units) = 'object'),
  forecast_value numeric(16, 2) not null default 0,
  forecast_achievement numeric(12, 6),
  target_value numeric(16, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_forecast_plans_period_key_shape check (
    (period_kind = 'month' and period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    or (period_kind = 'quarter' and period_key ~ '^[0-9]{4}-Q[1-4]$')
    or (period_kind = 'semester' and period_key ~ '^[0-9]{4}-H[12]$')
  )
);

comment on table public.sales_forecast_plans is
  'Make It Happen saved forecast plans. units = product_code -> whole units; values are save-time snapshots.';

create index if not exists sales_forecast_plans_owner_period_idx
  on public.sales_forecast_plans (owner_hr_id, period_kind, period_key, updated_at desc);

alter table public.sales_forecast_plans enable row level security;

drop policy if exists sales_forecast_plans_service_role on public.sales_forecast_plans;
create policy sales_forecast_plans_service_role on public.sales_forecast_plans
  for all to service_role using (true) with check (true);

revoke all on table public.sales_forecast_plans from anon;
revoke all on table public.sales_forecast_plans from authenticated;
revoke all on table public.sales_forecast_plans from public;
grant all on table public.sales_forecast_plans to service_role;

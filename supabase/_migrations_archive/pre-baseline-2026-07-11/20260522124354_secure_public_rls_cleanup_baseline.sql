-- Compatibility baseline for optional server-only legacy tables referenced by
-- the secure public RLS cleanup migration.

begin;

create table if not exists public.employee_salary_structure (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leave_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.leave_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  event_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.salary_allowance_defaults (
  id uuid primary key default gen_random_uuid(),
  allowance_key text unique,
  amount numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_salary_structure enable row level security;
alter table public.leave_notification_attempts enable row level security;
alter table public.leave_request_events enable row level security;
alter table public.salary_allowance_defaults enable row level security;

notify pgrst, 'reload schema';

commit;

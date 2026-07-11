-- Compatibility baseline for optional tables referenced by FK index cleanup.

begin;

create table if not exists public.coaching_reports (
  id uuid primary key default gen_random_uuid(),
  report_number text not null unique default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  medical_rep_hr_id text not null,
  coach_hr_id text not null,
  coach_role text null,
  coaching_date date not null,
  coaching_month integer generated always as (extract(month from coaching_date)::integer) stored,
  coaching_quarter integer generated always as (extract(quarter from coaching_date)::integer) stored,
  coaching_year integer generated always as (extract(year from coaching_date)::integer) stored,
  line_id integer null,
  area_id integer null,
  team_id integer null,
  area_of_development text null,
  strength_points text null,
  general_remarks text null,
  actual_score numeric not null default 0,
  max_score numeric not null default 120,
  final_score_percent numeric not null default 0,
  performance_zone text null,
  status text not null default 'draft',
  employee_acknowledged boolean not null default false,
  acknowledged_at timestamptz null,
  submitted_at timestamptz null,
  locked_at timestamptz null,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaching_reports_status_check check (
    status in ('draft', 'submitted', 'reviewed_by_employee', 'locked', 'cancelled')
  ),
  constraint coaching_reports_zone_check check (
    performance_zone is null or performance_zone in (
      'critical_red',
      'red_zone',
      'yellow_zone',
      'green_zone',
      'excellence_zone'
    )
  )
);

create table if not exists public.geo_bricks (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.password_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  created_by_login_id text,
  token_hash text,
  expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.coaching_reports enable row level security;
alter table public.geo_bricks enable row level security;
alter table public.password_setup_tokens enable row level security;

notify pgrst, 'reload schema';

commit;

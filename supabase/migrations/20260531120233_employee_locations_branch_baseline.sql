-- Compatibility baseline for employee location records referenced by RLS and
-- employee-master migrations.

begin;

create table if not exists public.employee_locations (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  residence_address text,
  residence_city text,
  residence_area text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_locations_employee_hr_id_idx
  on public.employee_locations (employee_hr_id);

alter table public.employee_locations enable row level security;

notify pgrst, 'reload schema';

commit;

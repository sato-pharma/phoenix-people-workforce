create table if not exists public.sidebar_module_assignments (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('user', 'role', 'position', 'line')),
  target_key text not null,
  navigation_mode text not null check (navigation_mode in ('admin', 'employee-portal')),
  module_id text not null,
  sort_order integer not null check (sort_order >= 0),
  is_enabled boolean not null default true,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidebar_module_assignments_unique_module
    unique (target_type, target_key, navigation_mode, module_id)
);

create index if not exists sidebar_module_assignments_target_order_idx
  on public.sidebar_module_assignments (target_type, target_key, navigation_mode, sort_order);

create index if not exists sidebar_module_assignments_module_idx
  on public.sidebar_module_assignments (navigation_mode, module_id)
  where is_enabled = true;

create or replace function public.set_sidebar_module_assignments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sidebar_module_assignments_set_updated_at on public.sidebar_module_assignments;
create trigger sidebar_module_assignments_set_updated_at
before update on public.sidebar_module_assignments
for each row
execute function public.set_sidebar_module_assignments_updated_at();

alter table public.sidebar_module_assignments enable row level security;
alter table public.sidebar_module_assignments force row level security;

revoke all on table public.sidebar_module_assignments from anon, authenticated;
grant select, insert, update, delete on table public.sidebar_module_assignments to service_role;

drop policy if exists sidebar_module_assignments_service_role_all on public.sidebar_module_assignments;
create policy sidebar_module_assignments_service_role_all
  on public.sidebar_module_assignments
  for all
  to service_role
  using (true)
  with check (true);

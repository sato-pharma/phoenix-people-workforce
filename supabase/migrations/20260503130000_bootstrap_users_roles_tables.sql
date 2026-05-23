-- Bootstrap public.users, public.roles, public.user_roles, and related tables
-- that exist only on production (created via phoenix-rbac-access-control.sql)
-- but are missing on fresh Supabase preview branches.
--
-- All statements use IF NOT EXISTS / DO $$ blocks so this is a no-op on
-- production and on branches that already ran the original setup script.

-- ---------------------------------------------------------------------------
-- Roles catalog
-- ---------------------------------------------------------------------------

create table if not exists public.roles (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  description text        null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RBAC supporting tables
-- ---------------------------------------------------------------------------

create table if not exists public.access_scopes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (name in ('SELF', 'TEAM', 'HIERARCHY', 'LINE', 'COMPANY', 'NONE')),
  description text null
);

create table if not exists public.permissions (
  id       uuid primary key default gen_random_uuid(),
  resource text not null,
  action   text not null,
  created_at timestamptz not null default now(),
  unique(resource, action)
);

create table if not exists public.role_permission_overrides (
  role_name  text    not null,
  resource   text    not null,
  action     text    not null,
  is_allowed boolean not null default true,
  updated_by text    null,
  updated_at timestamptz not null default now(),
  primary key (role_name, resource, action)
);

-- ---------------------------------------------------------------------------
-- Users (profile table bridging auth.users → employees)
-- employee_hr_id mirrors hr_id and is kept for index compatibility with
-- supabase/migrations/20260509032123_security_first_performance_batch_20260509.sql
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id                   uuid        primary key default gen_random_uuid(),
  hr_id                text        null references public.employees(hr_id) on update cascade on delete set null,
  employee_hr_id       text        null references public.employees(hr_id) on update cascade on delete set null,
  name                 text        not null default '',
  username             text        not null unique,
  email                text        null unique,
  password_hash        text        not null default '',
  line                 text        not null default 'Other'
                                   check (line in ('CNS', 'Pedia', 'Anti-Infective', 'Office', 'Other')),
  manager_hr_id        text        null references public.employees(hr_id) on update cascade on delete set null,
  is_active            boolean     not null default true,
  sales_scope_override text        null
                                   check (sales_scope_override in ('SELF', 'TEAM', 'HIERARCHY', 'LINE', 'COMPANY', 'NONE')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists users_hr_id_idx          on public.users (hr_id);
create index if not exists users_employee_hr_id_idx on public.users (employee_hr_id);
create index if not exists users_manager_hr_id_idx  on public.users (manager_hr_id);
create index if not exists users_line_idx            on public.users (line);

-- ---------------------------------------------------------------------------
-- User ↔ Role join table
-- ---------------------------------------------------------------------------

create table if not exists public.user_roles (
  user_id     uuid        not null references public.users(id) on delete cascade,
  role_id     uuid        not null references public.roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by text        null,
  primary key (user_id, role_id)
);

create index if not exists user_roles_user_id_idx         on public.user_roles (user_id);
create index if not exists user_roles_role_id_idx         on public.user_roles (role_id);
create index if not exists user_roles_assigned_by_user_id_idx on public.user_roles (assigned_by);

-- ---------------------------------------------------------------------------
-- RLS — enable and create base policies (20260509031312 will ALTER these)
-- ---------------------------------------------------------------------------

alter table public.users      enable row level security;
alter table public.roles      enable row level security;
alter table public.user_roles enable row level security;

-- public.users policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_select_own'
  ) then
    execute 'create policy users_select_own on public.users for select using (id = auth.uid())';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_update_own'
  ) then
    execute 'create policy users_update_own on public.users for update using (id = auth.uid()) with check (id = auth.uid())';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'phx_users_service_role'
  ) then
    execute 'create policy phx_users_service_role on public.users to service_role using (true) with check (true)';
  end if;
end $$;

-- public.roles policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'roles' and policyname = 'phx_roles_service_role'
  ) then
    execute 'create policy phx_roles_service_role on public.roles to service_role using (true) with check (true)';
  end if;
end $$;

-- public.user_roles policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'phx_user_roles_service_role'
  ) then
    execute 'create policy phx_user_roles_service_role on public.user_roles to service_role using (true) with check (true)';
  end if;
end $$;

-- Bootstrap app_auth_users and user_access_profiles for preview branches.
--
-- These tables were created directly on the production database before the
-- migration history was formalised. Supabase Preview branches spin up a fresh
-- database and run every migration from scratch, so they require CREATE TABLE
-- statements here. Using CREATE TABLE IF NOT EXISTS / CREATE POLICY IF NOT EXISTS
-- makes this migration a no-op on production where the objects already exist.

-- ============================================================
-- app_auth_users
-- ============================================================

create table if not exists public.app_auth_users (
  login_id              text        primary key,
  hr_id                 text        null,
  name                  text        null,
  email                 text        null,
  role                  text        not null default 'Employee',
  is_active             boolean     not null default true,
  line                  text        null,
  manager_hr_id         text        null,
  password_hash         text        null,
  auth_user_id          uuid        null,
  auth_email            text        null,
  session_version       integer     not null default 1,
  force_password_reset  boolean     not null default false,
  sales_scope_override  text        null,
  failed_login_attempts integer     not null default 0,
  last_failed_login_at  timestamptz null,
  locked_until          timestamptz null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- Case-insensitive login_id lookup used by all auth flows.
create unique index if not exists app_auth_users_login_id_idx
  on public.app_auth_users (lower(login_id));
create index if not exists app_auth_users_hr_id_idx
  on public.app_auth_users (hr_id)
  where hr_id is not null;
create unique index if not exists app_auth_users_auth_user_id_idx
  on public.app_auth_users (auth_user_id)
  where auth_user_id is not null;
alter table public.app_auth_users enable row level security;
-- Policies required by the auth-security-repair migration (20260509023802)
-- which alters these policies to their final definitions. They must exist
-- before that migration runs so ALTER POLICY succeeds.

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_auth_users'
      and policyname = 'app_auth_users_select_own'
  ) then
    execute 'create policy app_auth_users_select_own
      on public.app_auth_users
      for select
      using (auth_user_id = (select auth.uid()))';
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_auth_users'
      and policyname = 'app_auth_users_update_own'
  ) then
    execute 'create policy app_auth_users_update_own
      on public.app_auth_users
      for update
      using (auth_user_id = (select auth.uid()))
      with check (auth_user_id = (select auth.uid()))';
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_auth_users'
      and policyname = 'phx_app_auth_users_service_role'
  ) then
    execute 'create policy phx_app_auth_users_service_role
      on public.app_auth_users
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;
-- ============================================================
-- user_access_profiles
-- ============================================================

create table if not exists public.user_access_profiles (
  auth_user_id  uuid        primary key,
  hr_id         text        null,
  login_id      text        null,
  role          text        not null default 'employee',
  phoenix_role  text        null,
  is_active     boolean     not null default true,
  line          text        null,
  manager_hr_id text        null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists user_access_profiles_hr_id_idx
  on public.user_access_profiles (hr_id)
  where hr_id is not null;
create index if not exists user_access_profiles_login_id_idx
  on public.user_access_profiles (lower(login_id))
  where login_id is not null;
alter table public.user_access_profiles enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_access_profiles'
      and policyname = 'phx_user_access_profiles_service_role'
  ) then
    execute 'create policy phx_user_access_profiles_service_role
      on public.user_access_profiles
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;
notify pgrst, 'reload schema';

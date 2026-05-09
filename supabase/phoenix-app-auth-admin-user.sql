-- Phoenix Workforce app credential auth seed.
-- Idempotent: safe to run more than once in Supabase SQL editor.
-- Login IDs are generic: admin users can use names like admin-HR, employees use HR_ID.

create table if not exists public.app_auth_users (
  login_id text primary key,
  password_hash text not null,
  role text not null check (
    role in (
      'Employee',
      'Medical Rep',
      'District Manager',
      'Regional Manager',
      'National Sales Manager',
      'Product Manager',
      'Group Product Manager',
      'SFE Manager',
      'Training Manager',
      'Marketing Manager',
      'Finance Manager',
      'HR Specialist',
      'Manager',
      'CEO',
      'Super Admin'
    )
  ),
  hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_auth_users add column if not exists login_id text;
alter table public.app_auth_users add column if not exists password_hash text;
alter table public.app_auth_users add column if not exists role text not null default 'Employee';
alter table public.app_auth_users add column if not exists hr_id text null;
alter table public.app_auth_users add column if not exists is_active boolean not null default true;
alter table public.app_auth_users add column if not exists created_at timestamptz not null default now();
alter table public.app_auth_users add column if not exists updated_at timestamptz not null default now();

do $$
declare
  v_role_check_name text;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_auth_users'
      and column_name = 'username'
  ) then
    update public.app_auth_users
    set login_id = username
    where login_id is null;
  end if;

  select conname
    into v_role_check_name
  from pg_constraint
  where conrelid = 'public.app_auth_users'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%role%'
    and pg_get_constraintdef(oid) ilike '%in%'
  limit 1;

  if v_role_check_name is not null then
    execute format('alter table public.app_auth_users drop constraint %I', v_role_check_name);
  end if;
end $$;

do $$
begin
  begin
    alter table public.app_auth_users
      add constraint app_auth_users_role_check
      check (
        role in (
          'Employee',
          'Employee medical rep',
          'Medical Rep',
          'District Manager',
          'Regional Manager',
          'National Sales Manager',
          'Product Manager',
          'Group Product Manager',
          'SFE Manager',
          'Training Manager',
          'Marketing Manager',
          'Finance Manager',
          'HR Specialist',
          'Manager',
          'CEO',
          'Super Admin'
        )
      );
  exception
    when duplicate_object then
      null;
  end;
end $$;

create unique index if not exists app_auth_users_login_id_lower_idx
  on public.app_auth_users (lower(login_id));

create unique index if not exists app_auth_users_login_id_idx
  on public.app_auth_users (login_id);

create index if not exists app_auth_users_role_idx
  on public.app_auth_users (role)
  where is_active = true;

-- Bootstrap privileged accounts outside normal migrations.
-- Example secure one-time setup:
-- insert into public.app_auth_users (login_id, password_hash, role, hr_id, is_active)
-- values ('bootstrap-super-admin', '<bcrypt hash>', 'Super Admin', null, true);
--
-- To create employee login accounts, insert each employee with login_id = HR_ID.
-- Example:
-- insert into public.app_auth_users (login_id, password_hash, role, hr_id)
-- values ('B-187', '<bcrypt hash>', 'Medical Rep', 'B-187');

notify pgrst, 'reload schema';

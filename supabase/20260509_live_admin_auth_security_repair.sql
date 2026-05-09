-- Live Supabase repair for Phoenix Workforce.
-- Resolves app_auth_users/auth.users drift, backfills user_access_profiles,
-- enables the remaining service-role RLS protections, and revokes unsafe
-- direct RPC execution on sensitive SECURITY DEFINER functions.

create extension if not exists pgcrypto;

create temporary table tmp_phx_auth_bridge
on commit drop
as
select
  coalesce(a.auth_user_id, gen_random_uuid()) as auth_user_id,
  a.login_id,
  lower(trim(a.login_id)) as normalized_login_id,
  lower('phx-' || encode(convert_to(lower(trim(a.login_id)), 'UTF8'), 'hex') || '@auth.phoenix.local') as auth_email,
  a.password_hash,
  coalesce(nullif(trim(a.hr_id), ''), a.login_id) as effective_hr_id,
  coalesce(nullif(trim(a.name), ''), a.login_id) as effective_name,
  a.role as phoenix_role,
  case
    when a.role in ('Super Admin', 'CEO', 'Finance Manager') then 'admin'
    when a.role = 'HR Specialist' then 'hr'
    when a.role in (
      'District Manager',
      'Regional Manager',
      'National Sales Manager',
      'Product Manager',
      'Group Product Manager',
      'SFE Manager',
      'Training Manager',
      'Marketing Manager',
      'Manager'
    ) then 'manager'
    else 'employee'
  end as coarse_role,
  a.is_active,
  a.line,
  a.manager_hr_id
from public.app_auth_users a
where nullif(trim(a.login_id), '') is not null;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  is_super_admin,
  is_sso_user,
  is_anonymous
)
select
  null,
  t.auth_user_id,
  'authenticated',
  'authenticated',
  t.auth_email,
  t.password_hash,
  now(),
  jsonb_build_object(
    'coarse_access_role', t.coarse_role,
    'hr_id', t.effective_hr_id,
    'is_active', t.is_active,
    'line', t.line,
    'login_id', t.login_id,
    'phoenix_role', t.phoenix_role
  ),
  jsonb_build_object(
    'hr_id', t.effective_hr_id,
    'line', t.line,
    'login_id', t.login_id,
    'manager_hr_id', t.manager_hr_id,
    'name', t.effective_name,
    'phoenix_role', t.phoenix_role
  ),
  now(),
  now(),
  false,
  false,
  false
from tmp_phx_auth_bridge t
where not exists (
  select 1
  from auth.users u
  where u.id = t.auth_user_id
     or lower(coalesce(u.email, '')) = t.auth_email
);

update tmp_phx_auth_bridge t
set auth_user_id = u.id
from auth.users u
where lower(coalesce(u.email, '')) = t.auth_email;

update auth.users u
set
  aud = 'authenticated',
  role = 'authenticated',
  email = t.auth_email,
  encrypted_password = t.password_hash,
  email_confirmed_at = coalesce(u.email_confirmed_at, now()),
  raw_app_meta_data = jsonb_build_object(
    'coarse_access_role', t.coarse_role,
    'hr_id', t.effective_hr_id,
    'is_active', t.is_active,
    'line', t.line,
    'login_id', t.login_id,
    'phoenix_role', t.phoenix_role
  ),
  raw_user_meta_data = jsonb_build_object(
    'hr_id', t.effective_hr_id,
    'line', t.line,
    'login_id', t.login_id,
    'manager_hr_id', t.manager_hr_id,
    'name', t.effective_name,
    'phoenix_role', t.phoenix_role
  ),
  updated_at = now()
from tmp_phx_auth_bridge t
where u.id = t.auth_user_id;

insert into auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
select
  t.auth_email,
  t.auth_user_id,
  jsonb_build_object(
    'sub', t.auth_user_id::text,
    'email', t.auth_email,
    'email_verified', true
  ),
  'email',
  null,
  now(),
  now()
from tmp_phx_auth_bridge t
where not exists (
  select 1
  from auth.identities i
  where i.user_id = t.auth_user_id
    and i.provider = 'email'
);

update auth.identities i
set
  provider_id = t.auth_email,
  identity_data = jsonb_build_object(
    'sub', t.auth_user_id::text,
    'email', t.auth_email,
    'email_verified', true
  ),
  updated_at = now()
from tmp_phx_auth_bridge t
where i.user_id = t.auth_user_id
  and i.provider = 'email';

update public.app_auth_users a
set
  auth_user_id = t.auth_user_id,
  auth_email = t.auth_email
from tmp_phx_auth_bridge t
where a.login_id = t.login_id
  and (
    a.auth_user_id is distinct from t.auth_user_id
    or a.auth_email is distinct from t.auth_email
  );

insert into public.user_access_profiles (
  auth_user_id,
  hr_id,
  role,
  is_active,
  created_at,
  updated_at,
  login_id,
  line,
  manager_hr_id,
  phoenix_role
)
select
  t.auth_user_id,
  t.effective_hr_id,
  t.coarse_role,
  t.is_active,
  now(),
  now(),
  t.login_id,
  t.line,
  t.manager_hr_id,
  t.phoenix_role
from tmp_phx_auth_bridge t
where exists (
  select 1
  from public.employees e
  where lower(e.hr_id) = lower(t.effective_hr_id)
)
on conflict (auth_user_id) do update
set
  hr_id = excluded.hr_id,
  role = excluded.role,
  is_active = excluded.is_active,
  updated_at = now(),
  login_id = excluded.login_id,
  line = excluded.line,
  manager_hr_id = excluded.manager_hr_id,
  phoenix_role = excluded.phoenix_role;

do $$
declare
  t text;
  hardened_tables text[] := array[
    'teams',
    'positions',
    'roles',
    'user_roles',
    'system_audit_logs',
    'platform_settings',
    'notification_delivery_logs',
    'sales_import_batches',
    'sales_target_batches',
    'sales_targets',
    'sales_audit_logs'
  ];
begin
  foreach t in array hardened_tables
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

do $$
begin
  execute $sql$
    create or replace function public.current_access_role()
    returns text
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select coalesce(
        (
          select uap.role
          from public.user_access_profiles uap
          where uap.auth_user_id = auth.uid()
            and uap.is_active = true
          limit 1
        ),
        (
          select case
            when a.role in ('Super Admin', 'CEO', 'Finance Manager') then 'admin'
            when a.role = 'HR Specialist' then 'hr'
            when a.role in (
              'District Manager',
              'Regional Manager',
              'National Sales Manager',
              'Product Manager',
              'Group Product Manager',
              'SFE Manager',
              'Training Manager',
              'Marketing Manager',
              'Manager'
            ) then 'manager'
            else 'employee'
          end
          from public.app_auth_users a
          where a.auth_user_id = auth.uid()
            and a.is_active = true
          limit 1
        ),
        'employee'
      );
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_hr_id()
    returns text
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select coalesce(
        (
          select uap.hr_id
          from public.user_access_profiles uap
          where uap.auth_user_id = auth.uid()
            and uap.is_active = true
          limit 1
        ),
        (
          select coalesce(nullif(trim(a.hr_id), ''), a.login_id)
          from public.app_auth_users a
          where a.auth_user_id = auth.uid()
            and a.is_active = true
          limit 1
        )
      );
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_manager_hr_id()
    returns text
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select coalesce(
        (
          select uap.manager_hr_id
          from public.user_access_profiles uap
          where uap.auth_user_id = auth.uid()
            and uap.is_active = true
          limit 1
        ),
        (
          select a.manager_hr_id
          from public.app_auth_users a
          where a.auth_user_id = auth.uid()
            and a.is_active = true
          limit 1
        )
      );
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_line()
    returns text
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select coalesce(
        (
          select uap.line
          from public.user_access_profiles uap
          where uap.auth_user_id = auth.uid()
            and uap.is_active = true
          limit 1
        ),
        (
          select a.line
          from public.app_auth_users a
          where a.auth_user_id = auth.uid()
            and a.is_active = true
          limit 1
        )
      );
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_is_admin()
    returns boolean
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select public.current_access_role() in ('admin', 'hr');
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_can_manage_employees()
    returns boolean
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select public.current_access_role() in ('admin', 'hr');
    $fn$;
  $sql$;

  execute $sql$
    create or replace function public.current_access_can_see_employee(employee_hr_id text, employee_manager_hr_id text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = public
    as $fn$
      select
        public.current_access_is_admin()
        or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        or (
          public.current_access_role() = 'manager'
          and lower(coalesce(employee_manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        );
    $fn$;
  $sql$;

  if to_regprocedure('public.current_hr_id()') is not null then
    execute $sql$
      create or replace function public.current_hr_id()
      returns text
      language sql
      stable
      security definer
      set search_path = public
      as $fn$
        select coalesce(
          (
            select uap.hr_id
            from public.user_access_profiles uap
            where uap.auth_user_id = auth.uid()
              and uap.is_active = true
            limit 1
          ),
          (
            select a.hr_id
            from public.app_auth_users a
            where a.auth_user_id = auth.uid()
              and a.is_active = true
            limit 1
          )
        );
      $fn$;
    $sql$;
  end if;
end $$;

do $$
declare
  v_fn regprocedure;
begin
  select to_regprocedure('public.accept_offer_and_create_employee(uuid, text, date, date, date, date, date)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.accept_offer_and_create_employee(uuid, text, date, date, date, date, date) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.create_lifecycle_notification_event(text, text, date, text, jsonb)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.create_lifecycle_notification_event(text, text, date, text, jsonb) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_can_manage_employees()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_manage_employees() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_can_see_employee(text, text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_see_employee(text, text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_is_admin()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_is_admin() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_line()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_line() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_manager_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_manager_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_role()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_role() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.finalize_manual_employee_lifecycle(text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.finalize_manual_employee_lifecycle(text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.generate_employee_lifecycle_notifications(text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.generate_employee_lifecycle_notifications(text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.resign_employee_and_open_vacancy(text, date, date, text, text, text, boolean)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.resign_employee_and_open_vacancy(text, date, date, text, text, text, boolean) from public, anon, authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';

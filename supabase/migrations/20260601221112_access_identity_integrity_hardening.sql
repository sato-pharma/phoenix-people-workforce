-- Access identity integrity hardening.
-- Local migration artifact only until an explicit database apply is approved.
-- It prevents duplicate active access profiles and exposes read-only health
-- checks for orphan/misaligned app auth, Supabase Auth, and employee links.

do $$
begin
  if to_regclass('public.user_access_profiles') is null then
    raise exception 'public.user_access_profiles is required for access identity hardening.';
  end if;
  if to_regclass('public.app_auth_users') is null then
    raise exception 'public.app_auth_users is required for access identity hardening.';
  end if;
  if to_regclass('public.employees') is null then
    raise exception 'public.employees is required for access identity hardening.';
  end if;
end $$;

do $$
declare
  duplicate_count integer;
begin
  select count(*) into duplicate_count
  from (
    select auth_user_id
    from public.user_access_profiles
    where auth_user_id is not null
      and coalesce(is_active, true) = true
    group by auth_user_id
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'Duplicate active user_access_profiles.auth_user_id rows must be repaired before applying this migration. Duplicate groups: %', duplicate_count;
  end if;

  select count(*) into duplicate_count
  from (
    select lower(trim(login_id)) as login_key
    from public.user_access_profiles
    where nullif(trim(coalesce(login_id, '')), '') is not null
      and coalesce(is_active, true) = true
    group by lower(trim(login_id))
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'Duplicate active user_access_profiles.login_id rows must be repaired before applying this migration. Duplicate groups: %', duplicate_count;
  end if;

  select count(*) into duplicate_count
  from (
    select lower(trim(hr_id)) as hr_key
    from public.user_access_profiles
    where nullif(trim(coalesce(hr_id, '')), '') is not null
      and coalesce(is_active, true) = true
    group by lower(trim(hr_id))
    having count(*) > 1
  ) duplicates;
  if duplicate_count > 0 then
    raise exception 'Duplicate active user_access_profiles.hr_id rows must be repaired before applying this migration. Duplicate groups: %', duplicate_count;
  end if;
end $$;

create unique index if not exists user_access_profiles_active_auth_user_uidx
  on public.user_access_profiles (auth_user_id)
  where auth_user_id is not null
    and coalesce(is_active, true) = true;

create unique index if not exists user_access_profiles_active_login_id_uidx
  on public.user_access_profiles (lower(trim(login_id)))
  where nullif(trim(coalesce(login_id, '')), '') is not null
    and coalesce(is_active, true) = true;

create unique index if not exists user_access_profiles_active_hr_id_uidx
  on public.user_access_profiles (lower(trim(hr_id)))
  where nullif(trim(coalesce(hr_id, '')), '') is not null
    and coalesce(is_active, true) = true;

alter table public.app_auth_users
  drop constraint if exists app_auth_users_role_check;

alter table public.app_auth_users
  add constraint app_auth_users_role_check
  check (
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
  );

alter table public.user_access_profiles
  drop constraint if exists user_access_profiles_phoenix_role_check;

alter table public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check
  check (
    phoenix_role is null
    or phoenix_role in (
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
  );

alter table public.user_access_profiles
  drop constraint if exists user_access_profiles_scope_type_check;

alter table public.user_access_profiles
  add constraint user_access_profiles_scope_type_check
  check (
    scope_type is null
    or scope_type in (
      'SELF',
      'TEAM',
      'HIERARCHY',
      'LINE',
      'DEPARTMENT',
      'COMPANY',
      'COMPANY_READ',
      'FINANCE',
      'HR',
      'SUPER_ADMIN',
      'NONE'
    )
  );

create or replace view public.v_access_identity_health
with (security_invoker = true)
as
with active_profiles as (
  select
    auth_user_id,
    lower(trim(coalesce(hr_id, ''))) as hr_key,
    lower(trim(coalesce(login_id, ''))) as login_key,
    count(*) over (partition by auth_user_id) as auth_user_active_profile_count,
    count(*) over (partition by lower(trim(coalesce(hr_id, '')))) as hr_id_active_profile_count,
    count(*) over (partition by lower(trim(coalesce(login_id, '')))) as login_id_active_profile_count
  from public.user_access_profiles
  where coalesce(is_active, true) = true
)
select
  'duplicate_active_auth_user_profile'::text as issue_type,
  auth_user_id::text as entity_key,
  jsonb_build_object('count', auth_user_active_profile_count) as details
from active_profiles
where auth_user_id is not null
  and auth_user_active_profile_count > 1
union all
select
  'duplicate_active_hr_id_profile',
  hr_key,
  jsonb_build_object('count', hr_id_active_profile_count)
from active_profiles
where hr_key <> ''
  and hr_id_active_profile_count > 1
union all
select
  'duplicate_active_login_id_profile',
  login_key,
  jsonb_build_object('count', login_id_active_profile_count)
from active_profiles
where login_key <> ''
  and login_id_active_profile_count > 1
union all
select
  'active_employee_without_auth_user',
  e.hr_id,
  jsonb_build_object('employee_status', e.employment_status)
from public.employees e
where nullif(trim(coalesce(e.hr_id, '')), '') is not null
  and lower(coalesce(e.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive', 'left')
  and not exists (
    select 1
    from public.app_auth_users a
    where lower(trim(coalesce(a.hr_id, ''))) = lower(trim(e.hr_id))
  )
union all
select
  'auth_user_without_employee',
  a.login_id,
  jsonb_build_object('hr_id', a.hr_id, 'role', a.role)
from public.app_auth_users a
where nullif(trim(coalesce(a.hr_id, '')), '') is not null
  and not exists (
    select 1
    from public.employees e
    where lower(trim(coalesce(e.hr_id, ''))) = lower(trim(a.hr_id))
  )
union all
select
  'auth_user_missing_role',
  a.login_id,
  jsonb_build_object('hr_id', a.hr_id)
from public.app_auth_users a
where nullif(trim(coalesce(a.role, '')), '') is null;

revoke all on public.v_access_identity_health from anon;
grant select on public.v_access_identity_health to authenticated, service_role;

notify pgrst, 'reload schema';

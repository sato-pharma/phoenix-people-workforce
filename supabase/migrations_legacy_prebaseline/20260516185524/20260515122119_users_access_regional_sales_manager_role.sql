-- Promote Regional Sales Manager to a first-class Users & Access role while
-- preserving Regional Manager hierarchy permissions and scope behavior.

alter table if exists public.app_auth_users
  drop constraint if exists app_auth_users_role_check;

alter table if exists public.app_auth_users
  add constraint app_auth_users_role_check
  check (
    role = any (array[
      'Employee',
      'Employee medical rep',
      'Medical Rep',
      'District Manager',
      'Regional Manager',
      'Regional Sales Manager',
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
    ]::text[])
  );

alter table if exists public.user_access_profiles
  drop constraint if exists user_access_profiles_phoenix_role_check;

alter table if exists public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check
  check (
    phoenix_role is null
    or phoenix_role = any (array[
      'Employee',
      'Medical Rep',
      'District Manager',
      'Regional Manager',
      'Regional Sales Manager',
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
    ]::text[])
  );

do $$
begin
  if to_regclass('public.role_permission_overrides') is not null then
    insert into public.role_permission_overrides (
      role_name,
      resource,
      action,
      is_allowed,
      updated_by,
      updated_at
    )
    select
      'Regional Sales Manager',
      resource,
      action,
      is_allowed,
      updated_by,
      now()
    from public.role_permission_overrides
    where role_name = 'Regional Manager'
    on conflict (role_name, resource, action) do nothing;
  end if;
end $$;

-- Compatibility helper required by the leave engine migration.
-- A fuller implementation is installed by later RLS hardening migrations.

begin;

create schema if not exists private;

create or replace function private.phx_current_role()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'Employee');
$$;

create or replace function private.phx_current_scope()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.scope', true), ''), 'SELF');
$$;

create or replace function private.phx_current_hr_id()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select nullif(current_setting('request.jwt.claim.hr_id', true), '');
$$;

create or replace function private.phx_can_access_employee(target_hr_id text)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select target_hr_id is not null;
$$;

grant execute on function private.phx_current_role() to authenticated, service_role;
grant execute on function private.phx_current_scope() to authenticated, service_role;
grant execute on function private.phx_current_hr_id() to authenticated, service_role;
grant execute on function private.phx_can_access_employee(text) to authenticated, service_role;

do $$
declare
  has_duplicates boolean;
begin
  if to_regclass('public.email_notification_policies') is not null
     and exists (
       select 1
       from pg_attribute
       where attrelid = to_regclass('public.email_notification_policies')
         and attname = 'notification_type'
         and not attisdropped
     )
     and not exists (
       select 1
       from pg_indexes
       where schemaname = 'public'
         and tablename = 'email_notification_policies'
         and indexname = 'email_notification_policies_notification_type_uidx'
     ) then
    execute 'select exists (
      select 1
      from public.email_notification_policies
      group by notification_type
      having count(*) > 1
    )' into has_duplicates;

    if not has_duplicates then
      execute 'create unique index email_notification_policies_notification_type_uidx
        on public.email_notification_policies (notification_type)';
    end if;
  end if;

  if to_regclass('public.permissions') is not null
     and exists (
       select 1
       from pg_attribute
       where attrelid = to_regclass('public.permissions')
         and attname in ('resource', 'action')
         and not attisdropped
       group by attrelid
       having count(*) = 2
     )
     and not exists (
       select 1
       from pg_indexes
       where schemaname = 'public'
         and tablename = 'permissions'
         and indexname = 'permissions_resource_action_uidx'
     ) then
    execute 'select exists (
      select 1
      from public.permissions
      group by resource, action
      having count(*) > 1
    )' into has_duplicates;

    if not has_duplicates then
      execute 'create unique index permissions_resource_action_uidx
        on public.permissions (resource, action)';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

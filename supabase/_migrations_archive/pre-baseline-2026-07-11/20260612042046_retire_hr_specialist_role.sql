-- Retire the legacy HR Specialist access role.
--
-- Business rule:
-- - The old HR Specialist role is removed from app auth, profile constraints,
--   legacy RBAC rows, permission overrides, and workflow-registry permissions.
-- - A-16 is retained as a user but moved to the least-privilege recruitment
--   role "Talent Acquisition".
-- - Review/approval authority remains with HR Manager governance accounts that
--   hold Super Admin, plus Finance/CEO where already allowed.

begin;

create schema if not exists private;

do $$
begin
  if to_regclass('public.app_auth_users') is null then
    raise exception 'Required table public.app_auth_users is missing';
  end if;

  if to_regclass('public.user_access_profiles') is null then
    raise exception 'Required table public.user_access_profiles is missing';
  end if;
end $$;

alter table public.app_auth_users
  drop constraint if exists app_auth_users_role_check;

alter table public.user_access_profiles
  drop constraint if exists user_access_profiles_phoenix_role_check;

alter table public.user_access_profiles
  drop constraint if exists user_access_profiles_scope_type_check;

create temporary table tmp_retired_hr_role_identities on commit drop as
with candidates as (
  select
    aau.login_id,
    aau.hr_id,
    aau.auth_user_id,
    aau.is_active,
    case
      when regexp_replace(lower(coalesce(nullif(trim(aau.hr_id), ''), nullif(trim(aau.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
        then 'Talent Acquisition'
      else 'Employee'
    end as next_role
  from public.app_auth_users aau
  where aau.role = 'HR Specialist'
     or regexp_replace(lower(coalesce(nullif(trim(aau.hr_id), ''), nullif(trim(aau.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'

  union

  select
    uap.login_id,
    uap.hr_id,
    uap.auth_user_id,
    uap.is_active,
    case
      when regexp_replace(lower(coalesce(nullif(trim(uap.hr_id), ''), nullif(trim(uap.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
        then 'Talent Acquisition'
      else 'Employee'
    end as next_role
  from public.user_access_profiles uap
  where uap.phoenix_role = 'HR Specialist'
     or uap.role = 'hr'
     or regexp_replace(lower(coalesce(nullif(trim(uap.hr_id), ''), nullif(trim(uap.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
)
select distinct
  login_id,
  hr_id,
  auth_user_id,
  is_active,
  next_role
from candidates;

update public.app_auth_users aau
set
  role = case
    when regexp_replace(lower(coalesce(nullif(trim(aau.hr_id), ''), nullif(trim(aau.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
      then 'Talent Acquisition'
    else 'Employee'
  end,
  session_version = coalesce(aau.session_version, 1) + 1,
  updated_at = now()
where aau.role = 'HR Specialist'
   or regexp_replace(lower(coalesce(nullif(trim(aau.hr_id), ''), nullif(trim(aau.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16';

update public.user_access_profiles uap
set
  role = 'employee',
  phoenix_role = case
    when regexp_replace(lower(coalesce(nullif(trim(uap.hr_id), ''), nullif(trim(uap.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
      then 'Talent Acquisition'
    else 'Employee'
  end,
  scope_type = 'SELF',
  updated_at = now()
where uap.phoenix_role = 'HR Specialist'
   or uap.role = 'hr'
   or regexp_replace(lower(coalesce(nullif(trim(uap.hr_id), ''), nullif(trim(uap.login_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16';

update public.user_access_profiles
set
  role = 'employee',
  scope_type = 'SELF',
  updated_at = now()
where role = 'hr'
   or scope_type = 'HR';

update public.employees e
set
  job_title = 'Talent Acquisition',
  updated_at = now()
where regexp_replace(lower(coalesce(nullif(trim(e.hr_id), ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
  and e.job_title is distinct from 'Talent Acquisition';

do $retire_public_users_role$
declare
  has_role boolean;
  has_hr_id boolean;
  has_employee_hr_id boolean;
  has_updated_at boolean;
  identity_expr text;
  set_clause text;
  where_clause text;
begin
  if to_regclass('public.users') is null then
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'role'
  ) into has_role;

  if not has_role then
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'hr_id'
  ) into has_hr_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'employee_hr_id'
  ) into has_employee_hr_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'updated_at'
  ) into has_updated_at;

  identity_expr := case
    when has_hr_id and has_employee_hr_id then
      'regexp_replace(lower(coalesce(nullif(trim(hr_id::text), ''''), nullif(trim(employee_hr_id::text), ''''), '''')), ''[^a-z0-9]'', '''', ''g'')'
    when has_hr_id then
      'regexp_replace(lower(coalesce(nullif(trim(hr_id::text), ''''), '''')), ''[^a-z0-9]'', '''', ''g'')'
    when has_employee_hr_id then
      'regexp_replace(lower(coalesce(nullif(trim(employee_hr_id::text), ''''), '''')), ''[^a-z0-9]'', '''', ''g'')'
    else
      null
  end;

  set_clause := case
    when identity_expr is null then
      'role = ''Employee'''
    else
      format('role = case when %s = ''a16'' then ''Talent Acquisition'' else ''Employee'' end', identity_expr)
  end;

  if has_updated_at then
    set_clause := set_clause || ', updated_at = now()';
  end if;

  where_clause := 'lower(coalesce(role::text, '''')) = ''hr specialist''';

  if identity_expr is not null then
    where_clause := where_clause || format(' or %s = ''a16''', identity_expr);
  end if;

  execute format('update public.users set %s where %s', set_clause, where_clause);
end
$retire_public_users_role$;

with auth_updates as (
  select distinct on (auth_user_id)
    auth_user_id,
    login_id,
    hr_id,
    is_active,
    next_role
  from tmp_retired_hr_role_identities
  where auth_user_id is not null
  order by auth_user_id, case when next_role = 'Talent Acquisition' then 0 else 1 end
)
update auth.users au
set
  raw_app_meta_data = coalesce(au.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object(
      'coarse_access_role', 'employee',
      'hr_id', auth_updates.hr_id,
      'is_active', coalesce(auth_updates.is_active, true),
      'login_id', auth_updates.login_id,
      'phoenix_role', auth_updates.next_role
    ),
  raw_user_meta_data = coalesce(au.raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object(
      'hr_id', auth_updates.hr_id,
      'login_id', auth_updates.login_id,
      'phoenix_role', auth_updates.next_role
    ),
  updated_at = now()
from auth_updates
where au.id = auth_updates.auth_user_id;

update public.app_sessions s
set
  revoked_at = coalesce(s.revoked_at, now()),
  revoked_reason = coalesce(s.revoked_reason, 'Retired HR Specialist role and reassigned A-16')
where s.revoked_at is null
  and exists (
    select 1
    from tmp_retired_hr_role_identities i
    where lower(coalesce(i.login_id, '')) = lower(coalesce(s.login_id, ''))
       or lower(coalesce(i.hr_id, '')) = lower(coalesce(s.hr_id, ''))
  );

delete from public.role_permission_overrides
where lower(coalesce(role_name, '')) = 'hr specialist';

do $$
begin
  if to_regclass('public.user_roles') is not null and to_regclass('public.roles') is not null then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'roles'
        and column_name = 'key'
    ) then
      execute $sql$
        delete from public.user_roles ur
        using public.roles r
        where ur.role_id = r.id
          and (lower(coalesce(r.name, '')) = 'hr specialist' or lower(coalesce(r.key, '')) = 'hr_specialist')
      $sql$;
    else
      delete from public.user_roles ur
      using public.roles r
      where ur.role_id = r.id
        and lower(coalesce(r.name, '')) = 'hr specialist';
    end if;
  end if;

  if to_regclass('public.roles') is not null then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'roles'
        and column_name = 'key'
    ) then
      execute $sql$
        delete from public.roles
        where lower(coalesce(name, '')) = 'hr specialist'
           or lower(coalesce(key, '')) = 'hr_specialist'
      $sql$;

      execute $sql$
        insert into public.roles (key, name)
        select 'talent_acquisition', 'Talent Acquisition'
        where not exists (
          select 1
          from public.roles
          where lower(coalesce(name, '')) = 'talent acquisition'
             or lower(coalesce(key, '')) = 'talent_acquisition'
        )
      $sql$;
    else
      delete from public.roles
      where lower(coalesce(name, '')) = 'hr specialist';

      insert into public.roles (name)
      select 'Talent Acquisition'
      where not exists (
        select 1
        from public.roles
        where lower(coalesce(name, '')) = 'talent acquisition'
      );
    end if;
  end if;
end $$;

update public.workflow_registry_modules wrm
set
  actions = coalesce((
    select jsonb_agg(
      case
        when action_item.action ? 'allowedRoles' then
          jsonb_set(
            action_item.action,
            '{allowedRoles}',
            coalesce((
              select jsonb_agg(to_jsonb(role_name) order by first_seen)
              from (
                select role_name, min(role_index) as first_seen
                from (
                  select
                    case
                      when role_text = 'HR Specialist' and not restricted_action.is_restricted then 'Talent Acquisition'
                      when role_text in ('HR Specialist', 'Talent Acquisition') and restricted_action.is_restricted then null
                      else role_text
                    end as role_name,
                    role_item.role_index
                  from jsonb_array_elements(action_item.action -> 'allowedRoles') with ordinality as role_item(role_value, role_index)
                  cross join lateral (
                    select role_item.role_value #>> '{}' as role_text
                  ) role_text_value
                ) mapped_roles
                where role_name is not null
                group by role_name
              ) deduped_roles
            ), '[]'::jsonb)
          )
        else action_item.action
      end
      order by action_item.action_index
    )
    from jsonb_array_elements(wrm.actions) with ordinality as action_item(action, action_index)
    cross join lateral (
      select case
        when wrm.module_key = 'offers' then action_item.action ->> 'key' in (
          'offer_chain_approve',
          'offer_chain_reject',
          'offer_hire_approve'
        )
        when wrm.module_key = 'recruitment' then action_item.action ->> 'key' in (
          'app_offer_approved',
          'app_offer_approval_rejected',
          'app_hire'
        )
        else false
      end as is_restricted
    ) restricted_action
  ), '[]'::jsonb),
  updated_by = 'retire_hr_specialist_role',
  updated_at = now()
where wrm.module_key in ('recruitment', 'offers')
  and (
    wrm.actions::text like '%"HR Specialist"%'
    or wrm.actions::text like '%"Talent Acquisition"%'
  );

update public.workflow_registry_modules wrm
set
  actions = coalesce((
    select jsonb_agg(
      case
        when action ? 'allowedRoles' then
          jsonb_set(
            action,
            '{allowedRoles}',
            coalesce((
              select jsonb_agg(role_value)
              from jsonb_array_elements(action -> 'allowedRoles') role_value
              where role_value <> to_jsonb('HR Specialist'::text)
            ), '[]'::jsonb)
          )
        else action
      end
    )
    from jsonb_array_elements(wrm.actions) action
  ), '[]'::jsonb),
  updated_by = 'retire_hr_specialist_role',
  updated_at = now()
where wrm.module_key not in ('recruitment', 'offers')
  and wrm.actions::text like '%"HR Specialist"%';

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
      'Talent Acquisition',
      'Manager',
      'CEO',
      'Super Admin'
    )
  );

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
      'Talent Acquisition',
      'Manager',
      'CEO',
      'Super Admin'
    )
  );

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
      'COMPANY_READ',
      'FINANCE',
      'SUPER_ADMIN'
    )
  );

create or replace function private.phx_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select coalesce(
        uap.phoenix_role,
        case uap.role
          when 'super_admin' then 'Super Admin'
          when 'admin' then 'Super Admin'
          when 'company_reader' then 'CEO'
          when 'finance' then 'Finance Manager'
          when 'talent_acquisition' then 'Talent Acquisition'
          when 'hr' then 'Employee'
          when 'manager' then 'Manager'
          else 'Employee'
        end
      )
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.role
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    'Employee'
  );
$$;

create or replace function private.phx_current_scope()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.scope_type
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case private.phx_current_role()
      when 'Super Admin' then 'SUPER_ADMIN'
      when 'CEO' then 'COMPANY_READ'
      when 'SFE Manager' then 'COMPANY_READ'
      when 'Finance Manager' then 'FINANCE'
      when 'District Manager' then 'TEAM'
      when 'Manager' then 'TEAM'
      when 'Regional Manager' then 'HIERARCHY'
      when 'National Sales Manager' then 'LINE'
      when 'Product Manager' then 'LINE'
      when 'Group Product Manager' then 'LINE'
      when 'Training Manager' then 'LINE'
      when 'Marketing Manager' then 'LINE'
      else 'SELF'
    end
  );
$$;

create or replace function private.phx_has_company_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'CEO', 'SFE Manager')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'COMPANY_READ');
$$;

create or replace function private.phx_can_manage_workforce()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() = 'Super Admin'
    or private.phx_current_scope() = 'SUPER_ADMIN';
$$;

create or replace function private.phx_can_manage_payroll()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'Finance Manager')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'FINANCE');
$$;

create or replace function private.phx_can_manage_leave()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.phx_current_role(), 'Employee') in ('Super Admin', 'Finance Manager')
    or coalesce(private.phx_current_scope(), 'SELF') in ('SUPER_ADMIN', 'FINANCE');
$$;

create or replace function private.phx_can_manage_outstation()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in (
    'Super Admin',
    'Finance Manager',
    'District Manager',
    'Regional Manager',
    'National Sales Manager',
    'Manager'
  );
$$;

create or replace function private.phx_can_access_employee(target_hr_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor as (
    select e.hr_id, e.line_id, e.department_id
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    limit 1
  ),
  target as (
    select e.hr_id, e.manager_hr_id, e.line_id, e.department_id, e.employment_status
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(target_hr_id, ''))
    limit 1
  ),
  access_base as (
    select
      private.phx_has_company_access()
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      or exists (
        select 1
        from target
        where private.phx_current_scope() in ('TEAM', 'HIERARCHY')
          and lower(coalesce(target.manager_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('LINE', 'HIERARCHY')
          and actor.line_id is not null
          and actor.line_id = target.line_id
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('DEPARTMENT', 'SUPER_ADMIN')
          and actor.department_id is not null
          and actor.department_id = target.department_id
      ) as can_access
  )
  select coalesce(can_access, false)
    and (
      not exists (
        select 1
        from target
        where lower(coalesce(target.employment_status, 'active')) in ('resigned', 'terminated', 'inactive', 'left')
      )
      or private.phx_has_company_access()
    )
  from access_base;
$$;

grant execute on function private.phx_current_role() to authenticated, service_role;
grant execute on function private.phx_current_scope() to authenticated, service_role;
grant execute on function private.phx_has_company_access() to authenticated, service_role;
grant execute on function private.phx_can_manage_workforce() to authenticated, service_role;
grant execute on function private.phx_can_manage_payroll() to authenticated, service_role;
grant execute on function private.phx_can_manage_leave() to authenticated, service_role;
grant execute on function private.phx_can_manage_outstation() to authenticated, service_role;
grant execute on function private.phx_can_access_employee(text) to authenticated, service_role;

do $outer$
begin
  if to_regprocedure('public.current_access_role()') is not null then
    execute $fn$
      create or replace function public.current_access_role()
      returns text
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select coalesce(
          (
            select uap.role
            from public.user_access_profiles uap
            where uap.auth_user_id = (select auth.uid())
              and coalesce(uap.is_active, true) = true
            order by uap.updated_at desc nulls last
            limit 1
          ),
          case private.phx_current_role()
            when 'Super Admin' then 'super_admin'
            when 'CEO' then 'company_reader'
            when 'SFE Manager' then 'company_reader'
            when 'Finance Manager' then 'finance'
            when 'District Manager' then 'manager'
            when 'Regional Manager' then 'manager'
            when 'National Sales Manager' then 'manager'
            when 'Product Manager' then 'manager'
            when 'Group Product Manager' then 'manager'
            when 'Training Manager' then 'manager'
            when 'Marketing Manager' then 'manager'
            when 'Manager' then 'manager'
            else 'employee'
          end
        );
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.current_access_scope()') is not null then
    execute $fn$
      create or replace function public.current_access_scope()
      returns text
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select coalesce(
          (
            select uap.scope_type
            from public.user_access_profiles uap
            where uap.auth_user_id = (select auth.uid())
              and coalesce(uap.is_active, true) = true
            order by uap.updated_at desc nulls last
            limit 1
          ),
          case private.phx_current_role()
            when 'Super Admin' then 'SUPER_ADMIN'
            when 'CEO' then 'COMPANY_READ'
            when 'SFE Manager' then 'COMPANY_READ'
            when 'Finance Manager' then 'FINANCE'
            when 'District Manager' then 'TEAM'
            when 'Manager' then 'TEAM'
            when 'Regional Manager' then 'HIERARCHY'
            when 'National Sales Manager' then 'LINE'
            when 'Product Manager' then 'LINE'
            when 'Group Product Manager' then 'LINE'
            when 'Training Manager' then 'LINE'
            when 'Marketing Manager' then 'LINE'
            else 'SELF'
          end
        );
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.current_access_is_hr()') is not null then
    execute $fn$
      create or replace function public.current_access_is_hr()
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select false;
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.current_access_can_manage_employees()') is not null then
    execute $fn$
      create or replace function public.current_access_can_manage_employees()
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select private.phx_current_role() = 'Super Admin';
      $body$;
    $fn$;
  end if;

  if to_regprocedure('public.current_access_can_manage_payroll()') is not null then
    execute $fn$
      create or replace function public.current_access_can_manage_payroll()
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select private.phx_current_role() in ('Finance Manager', 'Super Admin');
      $body$;
    $fn$;
  end if;
end;
$outer$;

notify pgrst, 'reload schema';

commit;

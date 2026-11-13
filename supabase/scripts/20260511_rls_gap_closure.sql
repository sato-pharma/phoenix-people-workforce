-- Phoenix Workforce RLS gap closure.
-- Local migration artifact only until reviewed and applied to the target Supabase project.
-- Covers the live gap set: 1 table with RLS disabled and 10 RLS-enabled tables with no policies.

begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    execute 'create extension if not exists supabase_vault cascade';
  end if;

  if to_regnamespace('vault') is not null then
    execute 'revoke all on schema vault from public, anon, authenticated';
    execute 'revoke all on all tables in schema vault from public, anon, authenticated';
  end if;
end $$;

alter table if exists public.user_access_profiles
  add column if not exists phoenix_role text,
  add column if not exists scope_type text;

alter table if exists public.user_access_profiles
  drop constraint if exists user_access_profiles_scope_type_check;

alter table if exists public.user_access_profiles
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
      'HR',
      'SUPER_ADMIN'
    )
  );

alter table if exists public.app_auth_users
  add column if not exists auth_user_id uuid references auth.users(id) on update cascade on delete set null;

create or replace function private.phx_current_hr_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.hr_id
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.hr_id
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    )
  );
$$;

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
          when 'hr' then 'HR Specialist'
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
      when 'HR Specialist' then 'HR'
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
  select private.phx_current_role() in ('Super Admin', 'CEO', 'SFE Manager', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'COMPANY_READ', 'HR');
$$;

create or replace function private.phx_can_manage_workforce()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'HR');
$$;

create or replace function private.phx_can_manage_geo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in (
    'Super Admin',
    'HR Specialist',
    'SFE Manager',
    'Training Manager',
    'Finance Manager'
  );
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
    'HR Specialist',
    'Finance Manager',
    'District Manager',
    'Regional Manager',
    'National Sales Manager',
    'Manager'
  );
$$;

create or replace function private.phx_can_access_line(target_line text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor as (
    select e.line_id, l.name as line_name
    from public.employees e
    left join public.lines l on l.id = e.line_id
    where lower(e.hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    limit 1
  )
  select
    private.phx_has_company_access()
    or (
      target_line is not null
      and private.phx_current_scope() in ('LINE', 'HIERARCHY', 'TEAM')
      and exists (
        select 1
        from actor
        where lower(coalesce(actor.line_name, '')) = lower(coalesce(target_line, ''))
      )
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
        where private.phx_current_scope() in ('DEPARTMENT', 'HR', 'SUPER_ADMIN')
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
      or private.phx_current_role() in ('Super Admin', 'HR Specialist', 'Finance Manager')
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
    )
  from access_base;
$$;

grant execute on function private.phx_current_hr_id() to authenticated, service_role;
grant execute on function private.phx_current_role() to authenticated, service_role;
grant execute on function private.phx_current_scope() to authenticated, service_role;
grant execute on function private.phx_has_company_access() to authenticated, service_role;
grant execute on function private.phx_can_manage_workforce() to authenticated, service_role;
grant execute on function private.phx_can_manage_geo() to authenticated, service_role;
grant execute on function private.phx_can_manage_outstation() to authenticated, service_role;
grant execute on function private.phx_can_access_line(text) to authenticated, service_role;
grant execute on function private.phx_can_access_employee(text) to authenticated, service_role;

do $$
declare
  v_fn regprocedure;
begin
  foreach v_fn in array array[
    to_regprocedure('public.current_phoenix_role()'),
    to_regprocedure('public.current_access_role()'),
    to_regprocedure('public.current_access_scope()'),
    to_regprocedure('public.current_access_hr_id()'),
    to_regprocedure('public.current_access_manager_hr_id()'),
    to_regprocedure('public.current_access_line()'),
    to_regprocedure('public.current_access_is_super_admin()'),
    to_regprocedure('public.current_access_is_hr()'),
    to_regprocedure('public.current_access_is_finance()'),
    to_regprocedure('public.current_access_is_company_reader()'),
    to_regprocedure('public.current_access_is_admin()'),
    to_regprocedure('public.current_access_can_manage_employees()'),
    to_regprocedure('public.current_access_can_manage_payroll()'),
    to_regprocedure('public.current_access_can_see_employee(text, text)')
  ]
  loop
    if v_fn is not null then
      execute format('revoke all on function %s from public, anon', v_fn);
      execute format('grant execute on function %s to authenticated, service_role', v_fn);
    end if;
  end loop;
end $$;

alter table if exists public.employee_probation
  add column if not exists employee_hr_id text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_probation'
      and column_name = 'hr_id'
  ) then
    execute 'update public.employee_probation set employee_hr_id = hr_id where employee_hr_id is null and hr_id is not null';
  end if;
end $$;

alter table if exists public.employee_probation enable row level security;
alter table if exists public.brick_reference_imports enable row level security;
alter table if exists public.brick_reference_rows enable row level security;
alter table if exists public.employee_locations enable row level security;
alter table if exists public.geo_bricks enable row level security;
alter table if exists public.geo_locations enable row level security;
alter table if exists public.geo_trip_routes enable row level security;
alter table if exists public.outstation_expense_requests enable row level security;
alter table if exists public.outstation_location_audit_logs enable row level security;
alter table if exists public.outstation_policy_rules enable row level security;
alter table if exists public.password_setup_tokens enable row level security;

revoke all on table public.employee_probation from anon;
revoke all on table public.brick_reference_imports from anon;
revoke all on table public.brick_reference_rows from anon;
revoke all on table public.employee_locations from anon;
revoke all on table public.geo_bricks from anon;
revoke all on table public.geo_locations from anon;
revoke all on table public.geo_trip_routes from anon;
revoke all on table public.outstation_expense_requests from anon;
revoke all on table public.outstation_location_audit_logs from anon;
revoke all on table public.outstation_policy_rules from anon;
revoke all on table public.password_setup_tokens from anon, authenticated;

grant select, insert, update, delete on table public.employee_probation to authenticated, service_role;
grant select, insert, update, delete on table public.brick_reference_imports to authenticated, service_role;
grant select, insert, update, delete on table public.brick_reference_rows to authenticated, service_role;
grant select, insert, update, delete on table public.employee_locations to authenticated, service_role;
grant select, insert, update, delete on table public.geo_bricks to authenticated, service_role;
grant select, insert, update, delete on table public.geo_locations to authenticated, service_role;
grant select, insert, update, delete on table public.geo_trip_routes to authenticated, service_role;
grant select, insert, update, delete on table public.outstation_expense_requests to authenticated, service_role;
grant select, insert, update, delete on table public.outstation_location_audit_logs to authenticated, service_role;
grant select, insert, update, delete on table public.outstation_policy_rules to authenticated, service_role;
grant all on table public.password_setup_tokens to service_role;

create table if not exists public.sensitive_data_access_audit (
  id bigint generated by default as identity primary key,
  actor_auth_user_id uuid null,
  actor_hr_id text null,
  actor_role text null,
  action text not null,
  table_name text not null,
  row_ref text null,
  reason text null,
  created_at timestamptz not null default now()
);

alter table public.sensitive_data_access_audit enable row level security;
revoke all on public.sensitive_data_access_audit from anon;
grant select, insert on public.sensitive_data_access_audit to authenticated;
grant all on public.sensitive_data_access_audit to service_role;

create index if not exists sensitive_data_access_audit_actor_created_idx
  on public.sensitive_data_access_audit (actor_hr_id, created_at desc);

create index if not exists sensitive_data_access_audit_table_created_idx
  on public.sensitive_data_access_audit (table_name, created_at desc);

create or replace function private.log_sensitive_data_access(
  p_table_name text,
  p_row_ref text,
  p_action text default 'select',
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  insert into public.sensitive_data_access_audit (
    actor_auth_user_id,
    actor_hr_id,
    actor_role,
    action,
    table_name,
    row_ref,
    reason
  )
  values (
    (select auth.uid()),
    private.phx_current_hr_id(),
    private.phx_current_role(),
    coalesce(nullif(trim(p_action), ''), 'select'),
    coalesce(nullif(trim(p_table_name), ''), 'unknown'),
    nullif(trim(coalesce(p_row_ref, '')), ''),
    nullif(trim(coalesce(p_reason, '')), '')
  );
end;
$$;

grant execute on function private.log_sensitive_data_access(text, text, text, text) to authenticated, service_role;

create or replace function private.log_sensitive_data_access_event(
  p_table_name text,
  p_row_ref text,
  p_action text default 'select',
  p_reason text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, private
as $$
begin
  perform private.log_sensitive_data_access(p_table_name, p_row_ref, p_action, p_reason);
  return true;
end;
$$;

grant execute on function private.log_sensitive_data_access_event(text, text, text, text) to authenticated, service_role;

drop policy if exists sensitive_data_access_audit_service_role on public.sensitive_data_access_audit;
create policy sensitive_data_access_audit_service_role
  on public.sensitive_data_access_audit
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists sensitive_data_access_audit_insert_own on public.sensitive_data_access_audit;
create policy sensitive_data_access_audit_insert_own
  on public.sensitive_data_access_audit
  for insert
  to authenticated
  with check (actor_auth_user_id = (select auth.uid()));

drop policy if exists sensitive_data_access_audit_select_privileged on public.sensitive_data_access_audit;
create policy sensitive_data_access_audit_select_privileged
  on public.sensitive_data_access_audit
  for select
  to authenticated
  using (private.phx_can_manage_workforce());

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employee_probation',
    'brick_reference_imports',
    'brick_reference_rows',
    'employee_locations',
    'geo_bricks',
    'geo_locations',
    'geo_trip_routes',
    'outstation_expense_requests',
    'outstation_location_audit_logs',
    'outstation_policy_rules',
    'password_setup_tokens'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_service_role', v_table);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      v_table || '_service_role',
      v_table
    );
  end loop;
end $$;

drop policy if exists employee_probation_select_access on public.employee_probation;
create policy employee_probation_select_access
  on public.employee_probation
  for select
  to authenticated
  using (private.phx_can_access_employee(employee_hr_id));

drop policy if exists employee_probation_insert_access on public.employee_probation;
create policy employee_probation_insert_access
  on public.employee_probation
  for insert
  to authenticated
  with check (private.phx_can_manage_workforce());

drop policy if exists employee_probation_update_access on public.employee_probation;
create policy employee_probation_update_access
  on public.employee_probation
  for update
  to authenticated
  using (private.phx_can_manage_workforce())
  with check (private.phx_can_manage_workforce());

drop policy if exists employee_probation_delete_access on public.employee_probation;
create policy employee_probation_delete_access
  on public.employee_probation
  for delete
  to authenticated
  using (private.phx_can_manage_workforce());

drop policy if exists brick_reference_imports_select_access on public.brick_reference_imports;
create policy brick_reference_imports_select_access
  on public.brick_reference_imports
  for select
  to authenticated
  using (private.phx_has_company_access() or private.phx_can_access_line(line));

drop policy if exists brick_reference_imports_write_access on public.brick_reference_imports;
create policy brick_reference_imports_write_access
  on public.brick_reference_imports
  for all
  to authenticated
  using (private.phx_can_manage_geo())
  with check (private.phx_can_manage_geo());

drop policy if exists brick_reference_rows_select_access on public.brick_reference_rows;
create policy brick_reference_rows_select_access
  on public.brick_reference_rows
  for select
  to authenticated
  using (
    private.phx_has_company_access()
    or private.phx_can_access_line(line)
    or private.phx_can_access_employee(dsm_hr_id)
  );

drop policy if exists brick_reference_rows_write_access on public.brick_reference_rows;
create policy brick_reference_rows_write_access
  on public.brick_reference_rows
  for all
  to authenticated
  using (private.phx_can_manage_geo())
  with check (private.phx_can_manage_geo());

drop policy if exists employee_locations_select_access on public.employee_locations;
create policy employee_locations_select_access
  on public.employee_locations
  for select
  to authenticated
  using (private.phx_can_access_employee(employee_hr_id));

drop policy if exists employee_locations_insert_access on public.employee_locations;
create policy employee_locations_insert_access
  on public.employee_locations
  for insert
  to authenticated
  with check (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists employee_locations_update_access on public.employee_locations;
create policy employee_locations_update_access
  on public.employee_locations
  for update
  to authenticated
  using (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  )
  with check (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists employee_locations_delete_access on public.employee_locations;
create policy employee_locations_delete_access
  on public.employee_locations
  for delete
  to authenticated
  using (private.phx_can_manage_workforce());

drop policy if exists geo_locations_select_access on public.geo_locations;
create policy geo_locations_select_access
  on public.geo_locations
  for select
  to authenticated
  using (private.phx_has_company_access() or private.phx_can_access_line(line));

drop policy if exists geo_locations_write_access on public.geo_locations;
create policy geo_locations_write_access
  on public.geo_locations
  for all
  to authenticated
  using (private.phx_can_manage_geo())
  with check (private.phx_can_manage_geo());

drop policy if exists geo_trip_routes_select_access on public.geo_trip_routes;
create policy geo_trip_routes_select_access
  on public.geo_trip_routes
  for select
  to authenticated
  using (
    private.phx_has_company_access()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists geo_trip_routes_write_access on public.geo_trip_routes;
create policy geo_trip_routes_write_access
  on public.geo_trip_routes
  for all
  to authenticated
  using (private.phx_can_manage_geo())
  with check (private.phx_can_manage_geo());

drop policy if exists geo_bricks_select_access on public.geo_bricks;
create policy geo_bricks_select_access
  on public.geo_bricks
  for select
  to authenticated
  using (
    private.phx_has_company_access()
    or private.phx_can_access_line(line)
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists geo_bricks_write_access on public.geo_bricks;
create policy geo_bricks_write_access
  on public.geo_bricks
  for all
  to authenticated
  using (private.phx_can_manage_geo())
  with check (private.phx_can_manage_geo());

drop policy if exists outstation_policy_rules_select_access on public.outstation_policy_rules;
create policy outstation_policy_rules_select_access
  on public.outstation_policy_rules
  for select
  to authenticated
  using (true);

drop policy if exists outstation_policy_rules_write_access on public.outstation_policy_rules;
create policy outstation_policy_rules_write_access
  on public.outstation_policy_rules
  for all
  to authenticated
  using (private.phx_can_manage_outstation())
  with check (private.phx_can_manage_outstation());

drop policy if exists outstation_expense_requests_select_access on public.outstation_expense_requests;
create policy outstation_expense_requests_select_access
  on public.outstation_expense_requests
  for select
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists outstation_expense_requests_insert_access on public.outstation_expense_requests;
create policy outstation_expense_requests_insert_access
  on public.outstation_expense_requests
  for insert
  to authenticated
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_expense_requests_update_access on public.outstation_expense_requests;
create policy outstation_expense_requests_update_access
  on public.outstation_expense_requests
  for update
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or (
      lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      and status in ('draft', 'submitted')
    )
  )
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_expense_requests_delete_access on public.outstation_expense_requests;
create policy outstation_expense_requests_delete_access
  on public.outstation_expense_requests
  for delete
  to authenticated
  using (private.phx_can_manage_outstation());

drop policy if exists outstation_location_audit_logs_select_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_select_access
  on public.outstation_location_audit_logs
  for select
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists outstation_location_audit_logs_insert_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_insert_access
  on public.outstation_location_audit_logs
  for insert
  to authenticated
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_location_audit_logs_update_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_update_access
  on public.outstation_location_audit_logs
  for update
  to authenticated
  using (private.phx_can_manage_outstation())
  with check (private.phx_can_manage_outstation());

drop policy if exists outstation_location_audit_logs_delete_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_delete_access
  on public.outstation_location_audit_logs
  for delete
  to authenticated
  using (private.phx_can_manage_outstation());

do $$
begin
  if to_regclass('public.v_hr_id_orphan_audit') is not null then
    execute 'alter view public.v_hr_id_orphan_audit set (security_invoker = true)';
  end if;
end $$;

create or replace view public.v_employee_locations_masked
with (security_invoker = true)
as
select
  el.id,
  el.employee_hr_id,
  case
    when private.phx_can_manage_workforce()
      or lower(coalesce(el.employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      then el.residence_address
    else null
  end as residence_address,
  el.residence_city,
  el.residence_area,
  case
    when private.phx_can_manage_workforce()
      or lower(coalesce(el.employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      then el.residence_latitude
    else round(el.residence_latitude::numeric, 2)::double precision
  end as residence_latitude,
  case
    when private.phx_can_manage_workforce()
      or lower(coalesce(el.employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      then el.residence_longitude
    else round(el.residence_longitude::numeric, 2)::double precision
  end as residence_longitude,
  el.geocode_status,
  el.updated_at,
  el.created_at
from public.employee_locations el
where private.phx_can_access_employee(el.employee_hr_id)
  and private.log_sensitive_data_access_event(
    'employee_locations',
    el.employee_hr_id,
    'select',
    'v_employee_locations_masked'
  );

revoke all on public.v_employee_locations_masked from anon;
grant select on public.v_employee_locations_masked to authenticated, service_role;

do $$
begin
  if to_regclass('public.employee_locations') is not null then
    update public.employee_locations child
    set employee_hr_id = parent.hr_id
    from public.employees parent
    where child.employee_hr_id is not null
      and child.employee_hr_id <> parent.hr_id
      and lower(child.employee_hr_id) = lower(parent.hr_id);
  end if;

  if to_regclass('public.employee_probation') is not null then
    update public.employee_probation child
    set employee_hr_id = parent.hr_id
    from public.employees parent
    where child.employee_hr_id is not null
      and child.employee_hr_id <> parent.hr_id
      and lower(child.employee_hr_id) = lower(parent.hr_id);
  end if;

  if to_regclass('public.geo_trip_routes') is not null then
    update public.geo_trip_routes child
    set employee_hr_id = parent.hr_id
    from public.employees parent
    where child.employee_hr_id is not null
      and child.employee_hr_id <> parent.hr_id
      and lower(child.employee_hr_id) = lower(parent.hr_id);
  end if;

  if to_regclass('public.geo_bricks') is not null then
    update public.geo_bricks child
    set employee_hr_id = parent.hr_id
    from public.employees parent
    where child.employee_hr_id is not null
      and child.employee_hr_id <> parent.hr_id
      and lower(child.employee_hr_id) = lower(parent.hr_id);
  end if;

  if to_regclass('public.outstation_expense_requests') is not null then
    update public.outstation_expense_requests child
    set employee_hr_id = parent.hr_id
    from public.employees parent
    where child.employee_hr_id is not null
      and child.employee_hr_id <> parent.hr_id
      and lower(child.employee_hr_id) = lower(parent.hr_id);
  end if;
end $$;

do $$
begin
  if to_regclass('public.employee_locations') is not null
    and not exists (select 1 from pg_constraint where conname = 'employee_locations_employee_hr_id_fkey') then
    alter table public.employee_locations
      add constraint employee_locations_employee_hr_id_fkey
      foreign key (employee_hr_id)
      references public.employees(hr_id)
      on update cascade
      on delete cascade
      not valid;
  end if;

  if to_regclass('public.employee_probation') is not null
    and not exists (select 1 from pg_constraint where conname = 'employee_probation_employee_hr_id_fkey') then
    alter table public.employee_probation
      add constraint employee_probation_employee_hr_id_fkey
      foreign key (employee_hr_id)
      references public.employees(hr_id)
      on update cascade
      on delete cascade
      not valid;
  end if;

  if to_regclass('public.geo_trip_routes') is not null
    and not exists (select 1 from pg_constraint where conname = 'geo_trip_routes_employee_hr_id_fkey') then
    alter table public.geo_trip_routes
      add constraint geo_trip_routes_employee_hr_id_fkey
      foreign key (employee_hr_id)
      references public.employees(hr_id)
      on update cascade
      on delete set null
      not valid;
  end if;

  if to_regclass('public.geo_bricks') is not null
    and not exists (select 1 from pg_constraint where conname = 'geo_bricks_employee_hr_id_fkey') then
    alter table public.geo_bricks
      add constraint geo_bricks_employee_hr_id_fkey
      foreign key (employee_hr_id)
      references public.employees(hr_id)
      on update cascade
      on delete set null
      not valid;
  end if;

  if to_regclass('public.outstation_expense_requests') is not null
    and not exists (select 1 from pg_constraint where conname = 'outstation_expense_requests_employee_hr_id_fkey') then
    alter table public.outstation_expense_requests
      add constraint outstation_expense_requests_employee_hr_id_fkey
      foreign key (employee_hr_id)
      references public.employees(hr_id)
      on update cascade
      on delete restrict
      not valid;
  end if;
end $$;

commit;

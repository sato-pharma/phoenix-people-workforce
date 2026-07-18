-- Phoenix Workforce RBAC + access-control foundation.
-- Idempotent: safe to run more than once in Supabase SQL editor.

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.employees') is not null then
    alter table public.employees add column if not exists hr_id text null;
    alter table public.employees add column if not exists manager_hr_id text null;
    alter table public.employees add column if not exists line_id bigint null;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employees'
        and column_name = 'employee_code'
    ) then
      execute 'update public.employees set hr_id = employee_code where hr_id is null and employee_code is not null';
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employees'
        and column_name = 'code'
    ) then
      execute 'update public.employees set hr_id = code where hr_id is null and code is not null';
    end if;
    create index if not exists employees_hr_id_idx on public.employees (hr_id);
    create index if not exists employees_manager_hr_id_idx on public.employees (manager_hr_id);
    create index if not exists employees_line_id_idx on public.employees (line_id);
  end if;

  if to_regclass('public.app_auth_users') is not null then
    begin
      update public.app_auth_users
        set role = case
          when role = 'Medical Rep' then 'Medical Rep'
          when role = 'Employee medical rep' then 'Medical Rep'
          when role = 'Regional Sales Manager' then 'Regional Manager'
          when role = 'HR Manager' then 'HR Specialist'
          when role = 'District Sales Manager' then 'District Manager'
          when role = 'Manager' then 'Manager'
          else role
        end
      where lower(role) in (
        'medical rep',
        'employee medical rep',
        'regional sales manager',
        'hr manager',
        'district sales manager',
        'employee'
      );
    exception
      when check_violation then
        null;
    end;
  end if;
end $$;

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text null,
  created_at timestamptz not null default now()
);

create table if not exists public.access_scopes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name in ('SELF', 'TEAM', 'HIERARCHY', 'LINE', 'COMPANY', 'NONE')),
  description text null
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  resource text not null,
  action text not null,
  created_at timestamptz not null default now(),
  unique(resource, action)
);

create table if not exists public.role_permission_overrides (
  role_name text not null,
  resource text not null,
  action text not null,
  is_allowed boolean not null default true,
  updated_by text null,
  updated_at timestamptz not null default now(),
  primary key (role_name, resource, action)
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  name text not null,
  username text not null unique,
  email text null unique,
  password_hash text not null,
  line text not null default 'Other' check (line in ('CNS', 'Pedia', 'Anti Infective', 'Office', 'Other')),
  manager_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  is_active boolean not null default true,
  sales_scope_override text null check (sales_scope_override in ('SELF', 'TEAM', 'HIERARCHY', 'LINE', 'COMPANY', 'NONE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  user_id uuid not null references public.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by text null,
  primary key (user_id, role_id)
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_login_id text null,
  entity_type text not null,
  entity_id text null,
  summary text not null,
  old_values jsonb null,
  new_values jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists users_hr_id_idx on public.users (hr_id);
create index if not exists users_manager_hr_id_idx on public.users (manager_hr_id);
create index if not exists users_line_idx on public.users (line);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);

create table if not exists public.app_auth_users (
  login_id text primary key,
  password_hash text not null,
  role text not null default 'Employee',
  hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  name text null,
  email text null,
  line text not null default 'Other',
  manager_hr_id text null,
  sales_scope_override text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_auth_users_hr_id_idx on public.app_auth_users (hr_id);
create index if not exists app_auth_users_role_idx on public.app_auth_users (role);
create index if not exists app_auth_users_line_idx on public.app_auth_users (line);

do $$
begin
  if to_regclass('public.employees') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'employees'
         and column_name = 'hr_id'
     )
     and not exists (
       select 1
       from public.employees
       where hr_id is not null
       group by hr_id
       having count(*) > 1
     ) then
    if not exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.employees'::regclass
        and c.conname = 'employees_hr_id_unique'
    ) then
      alter table public.employees
        add constraint employees_hr_id_unique unique (hr_id);
    end if;

    if not exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.users'::regclass
        and c.conname = 'users_hr_id_fkey'
    ) then
      alter table public.users
        add constraint users_hr_id_fkey
        foreign key (hr_id) references public.employees(hr_id)
        on update cascade on delete set null;
    end if;

    if not exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.users'::regclass
        and c.conname = 'users_manager_hr_id_fkey'
    ) then
      alter table public.users
        add constraint users_manager_hr_id_fkey
        foreign key (manager_hr_id) references public.employees(hr_id)
        on update cascade on delete set null;
    end if;

    if not exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.app_auth_users'::regclass
        and c.conname = 'app_auth_users_hr_id_fkey'
    ) then
      alter table public.app_auth_users
        add constraint app_auth_users_hr_id_fkey
        foreign key (hr_id) references public.employees(hr_id)
        on update cascade on delete set null;
    end if;
  end if;
end $$;

do $$
begin
  create temporary table if not exists phoenix_role_seed (
    role_key text primary key,
    role_name text not null
  ) on commit drop;

  truncate table phoenix_role_seed;

  insert into phoenix_role_seed (role_key, role_name) values
    ('employee', 'Employee'),
    ('medical_rep', 'Medical Rep'),
    ('district_manager', 'District Manager'),
    ('regional_manager', 'Regional Manager'),
    ('national_sales_manager', 'National Sales Manager'),
    ('product_manager', 'Product Manager'),
    ('group_product_manager', 'Group Product Manager'),
    ('sfe_manager', 'SFE Manager'),
    ('training_manager', 'Training Manager'),
    ('marketing_manager', 'Marketing Manager'),
    ('finance_manager', 'Finance Manager'),
    ('hr_specialist', 'HR Specialist'),
    ('manager', 'Manager'),
    ('ceo', 'CEO'),
    ('super_admin', 'Super Admin');

  update public.roles
    set name = case
      when name = 'Employee medical rep' then 'Medical Rep'
      when name = 'Regional Sales Manager' then 'Regional Manager'
      when name = 'HR Manager' then 'HR Specialist'
      else name
    end
  where lower(name) in ('employee medical rep', 'medical rep', 'regional sales manager', 'hr manager');

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name = 'key'
  ) then
    insert into public.roles (key, name)
    select seed.role_key, seed.role_name
    from phoenix_role_seed seed
    where not exists (
      select 1
      from public.roles r
      where lower(r.name) = lower(seed.role_name)
         or lower(r.key) = lower(seed.role_key)
    );
  else
    insert into public.roles (name)
    select seed.role_name
    from phoenix_role_seed seed
    where not exists (
      select 1 from public.roles r where lower(r.name) = lower(seed.role_name)
    );
  end if;
end $$;

do $$
begin
  create temporary table if not exists phoenix_scope_seed (
    scope_key text primary key,
    scope_name text not null,
    scope_description text not null
  ) on commit drop;

  truncate table phoenix_scope_seed;

  insert into phoenix_scope_seed (scope_key, scope_name, scope_description) values
    ('self', 'SELF', 'Only the current user employee record.'),
    ('team', 'TEAM', 'Direct reports where manager_hr_id equals the current HR_ID.'),
    ('hierarchy', 'HIERARCHY', 'Recursive subordinate tree.'),
    ('line', 'LINE', 'Employees or records in the same line.'),
    ('company', 'COMPANY', 'Company-wide access.'),
    ('none', 'NONE', 'No business data access.');

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'access_scopes'
      and column_name = 'key'
  ) then
    insert into public.access_scopes (key, name, description)
    select seed.scope_key, seed.scope_name, seed.scope_description
    from phoenix_scope_seed seed
    where not exists (
      select 1
      from public.access_scopes s
      where upper(s.name) = upper(seed.scope_name)
         or lower(s.key) = lower(seed.scope_key)
    );
  else
    insert into public.access_scopes (name, description)
    select seed.scope_name, seed.scope_description
    from phoenix_scope_seed seed
    where not exists (
      select 1 from public.access_scopes s where upper(s.name) = upper(seed.scope_name)
    );
  end if;
end $$;

do $$
declare
  has_key_column boolean;
  has_name_column boolean;
begin
  create temporary table if not exists phoenix_permission_seed (
    permission_key text primary key,
    resource text not null,
    action text not null,
    permission_name text not null
  ) on commit drop;

  truncate table phoenix_permission_seed;

  insert into phoenix_permission_seed (permission_key, resource, action, permission_name) values
    ('admin.read','admin','read','Admin read'),
    ('admin.create','admin','create','Admin create'),
    ('admin.update','admin','update','Admin update'),
    ('admin.delete','admin','delete','Admin delete'),
    ('admin.import','admin','import','Admin import'),
    ('admin.export','admin','export','Admin export'),
    ('sales.read','sales','read','Sales read'),
    ('sales.create','sales','create','Sales create'),
    ('sales.update','sales','update','Sales update'),
    ('sales.delete','sales','delete','Sales delete'),
    ('sales.approve','sales','approve','Sales approve'),
    ('sales.import','sales','import','Sales import'),
    ('sales.export','sales','export','Sales export'),
    ('payroll.read','payroll','read','Payroll read'),
    ('payroll.create','payroll','create','Payroll create'),
    ('payroll.update','payroll','update','Payroll update'),
    ('payroll.delete','payroll','delete','Payroll delete'),
    ('payroll.approve','payroll','approve','Payroll approve'),
    ('payroll.import','payroll','import','Payroll import'),
    ('payroll.export','payroll','export','Payroll export'),
    ('employees.read','employees','read','Employees read'),
    ('employees.create','employees','create','Employees create'),
    ('employees.update','employees','update','Employees update'),
    ('employees.delete','employees','delete','Employees delete'),
    ('employees.import','employees','import','Employees import'),
    ('employees.export','employees','export','Employees export');

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'permissions'
      and column_name = 'key'
  ) into has_key_column;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'permissions'
      and column_name = 'name'
  ) into has_name_column;

  if has_key_column and has_name_column then
    insert into public.permissions (key, name, resource, action)
    select seed.permission_key, seed.permission_name, seed.resource, seed.action
    from phoenix_permission_seed seed
    where not exists (
      select 1
      from public.permissions existing
      where lower(existing.resource) = lower(seed.resource)
        and lower(existing.action) = lower(seed.action)
    );
  elsif has_key_column then
    insert into public.permissions (key, resource, action)
    select seed.permission_key, seed.resource, seed.action
    from phoenix_permission_seed seed
    where not exists (
      select 1
      from public.permissions existing
      where lower(existing.resource) = lower(seed.resource)
        and lower(existing.action) = lower(seed.action)
    );
  elsif has_name_column then
    insert into public.permissions (name, resource, action)
    select seed.permission_name, seed.resource, seed.action
    from phoenix_permission_seed seed
    where not exists (
      select 1
      from public.permissions existing
      where lower(existing.resource) = lower(seed.resource)
        and lower(existing.action) = lower(seed.action)
    );
  else
    insert into public.permissions (resource, action)
    select seed.resource, seed.action
    from phoenix_permission_seed seed
    where not exists (
      select 1
      from public.permissions existing
      where lower(existing.resource) = lower(seed.resource)
        and lower(existing.action) = lower(seed.action)
    );
  end if;
end $$;

do $$
declare
  v_roles_name_unique_exists boolean;
  v_scopes_name_unique_exists boolean;
  v_permissions_resource_action_unique_exists boolean;
begin
  select exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.roles'::regclass
      and c.contype in ('u', 'x')
      and exists (
        select 1
        from unnest(c.conkey) AS conkey_col(attnum)
        join pg_attribute a
          on a.attrelid = 'public.roles'::regclass
         and a.attnum = conkey_col.attnum
        where a.attname = 'name'
      )
  ) into v_roles_name_unique_exists;

  select exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.access_scopes'::regclass
      and c.contype in ('u', 'x')
      and exists (
        select 1
        from unnest(c.conkey) AS conkey_col(attnum)
        join pg_attribute a
          on a.attrelid = 'public.access_scopes'::regclass
         and a.attnum = conkey_col.attnum
        where a.attname = 'name'
      )
  ) into v_scopes_name_unique_exists;

  select exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.permissions'::regclass
      and c.contype in ('u', 'x')
      and exists (
        select 1
        from unnest(c.conkey) AS conkey_col(attnum)
        join pg_attribute a
          on a.attrelid = 'public.permissions'::regclass
         and a.attnum = conkey_col.attnum
        where a.attname = 'resource'
      )
      and exists (
        select 1
        from unnest(c.conkey) AS conkey_col(attnum)
        join pg_attribute a
          on a.attrelid = 'public.permissions'::regclass
         and a.attnum = conkey_col.attnum
        where a.attname = 'action'
      )
  ) into v_permissions_resource_action_unique_exists;

  if not v_roles_name_unique_exists then
    begin
      alter table public.roles add constraint roles_name_unique unique (name);
    exception
      when duplicate_object then null;
    end;
  end if;

  if not v_scopes_name_unique_exists then
    begin
      alter table public.access_scopes add constraint access_scopes_name_unique unique (name);
    exception
      when duplicate_object then null;
    end;
  end if;

  if not v_permissions_resource_action_unique_exists then
    begin
      alter table public.permissions add constraint permissions_resource_action_unique unique (resource, action);
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';

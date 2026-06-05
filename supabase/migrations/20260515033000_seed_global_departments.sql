-- Phoenix Workforce global department lookup seed.
-- Keeps legacy department rows intact. The legacy "Active" department is only marked inactive when no employees reference it.

alter table public.departments
  add column if not exists is_active boolean not null default true;
with approved_departments(code, name) as (
  values
    ('sales', 'Sales'),
    ('marketing', 'Marketing'),
    ('finance', 'Finance'),
    ('human_resources', 'Human Resources'),
    ('qppv', 'QPPV'),
    ('rd', 'R&D'),
    ('admins', 'Admins'),
    ('executive', 'Executive'),
    ('sfe', 'SFE'),
    ('supply_chain', 'Supply Chain')
),
matched_existing as (
  select d.id, a.code, a.name
  from public.departments d
  join approved_departments a
    on lower(trim(d.name)) = lower(a.name)
    or lower(trim(coalesce(d.code, ''))) = lower(a.code)
)
update public.departments d
set
  code = m.code,
  name = m.name,
  is_active = true,
  updated_at = now()
from matched_existing m
where d.id = m.id
  and (
    d.code is distinct from m.code
    or d.name is distinct from m.name
    or d.is_active is distinct from true
  );
with approved_departments(code, name) as (
  values
    ('sales', 'Sales'),
    ('marketing', 'Marketing'),
    ('finance', 'Finance'),
    ('human_resources', 'Human Resources'),
    ('qppv', 'QPPV'),
    ('rd', 'R&D'),
    ('admins', 'Admins'),
    ('executive', 'Executive'),
    ('sfe', 'SFE'),
    ('supply_chain', 'Supply Chain')
)
insert into public.departments (code, name, is_active, updated_at)
select a.code, a.name, true, now()
from approved_departments a
where not exists (
  select 1
  from public.departments d
  where lower(trim(d.name)) = lower(a.name)
     or lower(trim(coalesce(d.code, ''))) = lower(a.code)
);
do $$
declare
  active_department_id bigint;
  reference_count integer := 0;
begin
  select id into active_department_id
  from public.departments
  where lower(trim(name)) = 'active'
  limit 1;

  if active_department_id is null then
    raise notice 'Legacy department "Active" not present.';
    return;
  end if;

  select count(*) into reference_count
  from public.employees
  where department_id = active_department_id;

  if reference_count = 0 then
    update public.departments
    set is_active = false, updated_at = now()
    where id = active_department_id;
    raise notice 'Legacy department "Active" marked inactive because no employees reference it.';
  else
    raise notice 'Legacy department "Active" remains active because % employees reference it. Manual cleanup required.', reference_count;
  end if;
end $$;
comment on column public.departments.is_active is 'Controls whether the department is available as a global active lookup option.';

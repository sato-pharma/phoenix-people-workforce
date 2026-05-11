-- Repair legacy employee hire dates that were persisted one day early by Excel date parsing.
-- The update is evidence-based: only employees whose salary_records hire_date is exactly one
-- calendar day after employees.hire_date are corrected.

create schema if not exists internal;

revoke all on schema internal from public, anon, authenticated;

create table if not exists internal.phoenix_date_offset_repair_audit (
  id bigserial primary key,
  repair_key text not null,
  table_name text not null,
  primary_key text not null,
  column_name text not null,
  old_value date not null,
  new_value date not null,
  evidence text not null,
  repaired_at timestamptz not null default now(),
  unique (repair_key, table_name, primary_key, column_name)
);

with candidates as (
  select
    e.hr_id,
    e.hire_date as old_value,
    max(sr.hire_date) as new_value,
    count(*) as evidence_records
  from public.employees e
  join public.salary_records sr
    on upper(trim(sr.hr_id)) = upper(trim(e.hr_id))
  where e.hire_date is not null
    and sr.hire_date is not null
    and sr.hire_date = e.hire_date + interval '1 day'
  group by e.hr_id, e.hire_date
),
audit_insert as (
  insert into internal.phoenix_date_offset_repair_audit (
    repair_key,
    table_name,
    primary_key,
    column_name,
    old_value,
    new_value,
    evidence
  )
  select
    '20260511_employee_hire_date_salary_record_plus_one',
    'employees',
    hr_id,
    'hire_date',
    old_value,
    new_value,
    evidence_records || ' salary_records rows were exactly one day after employees.hire_date'
  from candidates
  on conflict (repair_key, table_name, primary_key, column_name) do nothing
  returning primary_key, old_value, new_value
)
update public.employees e
set
  hire_date = audit_insert.new_value,
  updated_at = now()
from audit_insert
where e.hr_id = audit_insert.primary_key
  and e.hire_date = audit_insert.old_value;

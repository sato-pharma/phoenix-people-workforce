-- Manager hierarchy history: captures every manager_hr_id change on employees,
-- including cascade-null events when a manager is deleted. This prevents silent
-- hierarchy data loss when set-null FK behaviour fires.

create table if not exists public.employees_manager_history (
  id                uuid        default gen_random_uuid() not null primary key,
  employee_hr_id    text        not null,
  old_manager_hr_id text,
  new_manager_hr_id text,
  changed_at        timestamptz not null default now(),
  change_source     text        not null default 'update'
    check (change_source in ('update', 'cascade_null', 'import'))
);

alter table public.employees_manager_history enable row level security;
revoke all on public.employees_manager_history from anon, authenticated;
grant select on public.employees_manager_history to service_role;

create index if not exists employees_manager_history_employee_idx
  on public.employees_manager_history (employee_hr_id, changed_at desc);
create index if not exists employees_manager_history_old_manager_idx
  on public.employees_manager_history (old_manager_hr_id)
  where old_manager_hr_id is not null;

-- Trigger function: fires after any update that changes manager_hr_id.
create or replace function public.trg_employees_manager_history_fn()
returns trigger language plpgsql security definer as $$
begin
  if old.manager_hr_id is distinct from new.manager_hr_id then
    insert into public.employees_manager_history (
      employee_hr_id,
      old_manager_hr_id,
      new_manager_hr_id,
      change_source
    ) values (
      new.hr_id,
      old.manager_hr_id,
      new.manager_hr_id,
      case
        when new.manager_hr_id is null then 'cascade_null'
        else 'update'
      end
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_employees_manager_history on public.employees;
create trigger trg_employees_manager_history
  after update of manager_hr_id on public.employees
  for each row execute function public.trg_employees_manager_history_fn();

-- View: employees whose manager was recently nulled (last 90 days).
-- Used by the data-health dashboard to surface orphaned hierarchy nodes.
create or replace view public.v_recently_orphaned_managers as
  select
    h.employee_hr_id,
    h.old_manager_hr_id,
    h.changed_at,
    e.full_name   as employee_name,
    e.department_name
  from public.employees_manager_history h
  left join public.employees e on lower(e.hr_id) = lower(h.employee_hr_id)
  where h.new_manager_hr_id is null
    and h.changed_at >= now() - interval '90 days'
  order by h.changed_at desc;

revoke all on public.v_recently_orphaned_managers from anon, authenticated;
grant select on public.v_recently_orphaned_managers to service_role;

notify pgrst, 'reload schema';

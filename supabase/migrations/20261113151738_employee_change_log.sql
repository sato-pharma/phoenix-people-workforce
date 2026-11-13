-- employee_change_log — every change to an employee record, by a database trigger
--
-- WHAT THIS CHANGES:
--   * public.employee_change_log — one append-only row per INSERT, UPDATE or DELETE of a
--     public.employees row that changed at least one recorded column: which columns changed,
--     their values before and after, when, and who.
--   * public.phx_log_employee_change() — the AFTER ROW trigger function that writes it.
--   * public.phx_refuse_history_change() — refuses UPDATE, DELETE and TRUNCATE on the log
--     (ENABLE ALWAYS, so `session_replication_role = replica` does not walk past it).
--   * public.v_employee_change_log — the readable timeline, names resolved, service role only.
--
-- WHY (enterprise audit 2026-11-13, finding F-HR-001, recommendation REC-039):
--   An employee save is one upsert (`employees?on_conflict=hr_id`, merge-duplicates). Until now
--   the only history was the salary trigger (20260924175023_employee_salary_change_log.sql).
--   Nothing recorded who moved a manager, a line, an area, a status, a hire date or the payroll
--   flag, or what the value was before — and the hire date drives probation, leave and payroll.
--   A trigger, not application code, because 170 files under src/lib write `employees` and a
--   history that one of them can skip is not a history.
--
-- WHAT IS RECORDED, AND WHAT IS ONLY NAMED:
--   * Ignored entirely: updated_at, total_experience_years, total_experience_as_of — stamped by
--     the row's own triggers on every save, so they would make every save look like a change.
--   * Named, never valued (`masked_fields`): the ten salary columns, whose values are already
--     kept by employee_salary_change_log, and the personal identifiers and contact details
--     (bank account, national id, social-insurance, medical-insurance and health-card numbers,
--     the Kaab Elamaal number, mobile number, personal e-mail, home address, birth date). The
--     log says THAT one changed and who changed it; it never stores the number.
--   * Everything else: the old and new value.
--
-- WHO: the acting user travels as the x-phoenix-actor-login-id / x-phoenix-actor-hr-id request
--   headers that upsertEmployee already sends for the salary trigger. A write that sends none
--   (a job, a bulk repair, raw SQL) is recorded with actor_source 'unattributed' — on purpose,
--   so an out-of-band change stands out instead of disappearing.
--
-- SIDE EFFECTS: one extra insert per changed employee row. A statement that updates every
--   employee writes one row per employee (about 250 today). The log has no foreign key to
--   employees, so it never blocks an employee write or a rename.
--
-- ROLLBACK (additive; nothing existing is altered):
--   drop view if exists public.v_employee_change_log;
--   drop trigger if exists phx_employees_change_log on public.employees;
--   drop function if exists public.phx_log_employee_change();
--   -- SAFE: drops only the log this migration created, and only on a deliberate rollback.
--   drop table if exists public.employee_change_log;
--   drop function if exists public.phx_refuse_history_change();
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it creates objects and writes no existing row.

begin;

create table if not exists public.employee_change_log (
  id             uuid        primary key default gen_random_uuid(),
  employee_hr_id text        not null,
  changed_at     timestamptz not null default clock_timestamp(),
  change_kind    text        not null check (change_kind in ('insert', 'update', 'delete')),
  actor_login_id text,
  actor_hr_id    text,
  actor_source   text        not null default 'unattributed'
                             check (actor_source in ('app', 'unattributed')),
  changed_fields text[]      not null default '{}',
  masked_fields  text[]      not null default '{}',
  old_values     jsonb       not null default '{}'::jsonb,
  new_values     jsonb       not null default '{}'::jsonb
);

comment on table public.employee_change_log is
  'Append-only history of public.employees, written by the phx_employees_change_log trigger. '
  'changed_fields names every changed column; masked_fields names the ones whose values are never '
  'stored (salary figures, kept with values by employee_salary_change_log, and personal '
  'identifiers). actor_source unattributed = the write sent no x-phoenix-actor-* header.';

create index if not exists employee_change_log_hr_id_changed_at_idx
  on public.employee_change_log (employee_hr_id, changed_at desc);

-- Service-role only, like every other audit table here: row security on, no policy.
alter table public.employee_change_log enable row level security;
revoke all on public.employee_change_log from public, anon, authenticated;
grant select, insert on public.employee_change_log to service_role;

-- ---------------------------------------------------------------- append-only

create or replace function public.phx_refuse_history_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'The % history is append-only. % is refused.', tg_table_name, tg_op
    using hint = 'A history row records what happened. To remove one, drop this trigger '
                 'deliberately in a migration, with the owner told first.';
  return null;
end;
$$;

comment on function public.phx_refuse_history_change() is
  'Refuses UPDATE, DELETE and TRUNCATE on an append-only history table. Binds the table owner, '
  'which a REVOKE does not.';

revoke execute on function public.phx_refuse_history_change() from public, anon, authenticated;
grant execute on function public.phx_refuse_history_change() to service_role;

drop trigger if exists employee_change_log_no_update on public.employee_change_log;
drop trigger if exists employee_change_log_no_delete on public.employee_change_log;
drop trigger if exists employee_change_log_no_truncate on public.employee_change_log;
create trigger employee_change_log_no_update before update on public.employee_change_log
  for each row execute function public.phx_refuse_history_change();
create trigger employee_change_log_no_delete before delete on public.employee_change_log
  for each row execute function public.phx_refuse_history_change();
-- TRUNCATE fires no row trigger, so it needs a statement-level one of its own.
create trigger employee_change_log_no_truncate before truncate on public.employee_change_log
  for each statement execute function public.phx_refuse_history_change();
alter table public.employee_change_log enable always trigger employee_change_log_no_update;
alter table public.employee_change_log enable always trigger employee_change_log_no_delete;
alter table public.employee_change_log enable always trigger employee_change_log_no_truncate;

-- ---------------------------------------------------------------- the writer

-- SECURITY DEFINER so the row is written whoever performs the employee write; the history must
-- never depend on the caller's privileges. Never called directly.
create or replace function public.phx_log_employee_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ignored constant text[] := array['updated_at', 'total_experience_years', 'total_experience_as_of'];
  masked  constant text[] := array[
    'base_salary', 'basic_salary', 'gross_salary', 'net_salary',
    'fuel_allowance', 'extra_cost_of_living', 'medical_insurance',
    'social_insurance', 'taxes', 'social_insurance_wage',
    'bank_account', 'national_id', 'social_insurance_number', 'medical_insurance_number',
    'health_card_number', 'kaab_elamaal_number', 'mobile_number', 'personal_email',
    'residence_address', 'birth_date'
  ];
  o        jsonb := '{}'::jsonb;
  n        jsonb := '{}'::jsonb;
  col      text;
  fields   text[] := '{}';
  hidden   text[] := '{}';
  old_diff jsonb := '{}'::jsonb;
  new_diff jsonb := '{}'::jsonb;
  v_hr_id  text;
  headers  json;
  v_login  text;
  v_hr     text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    o := to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    n := to_jsonb(new);
  end if;
  v_hr_id := coalesce(n ->> 'hr_id', o ->> 'hr_id');

  for col in select k from jsonb_object_keys(o || n) as k order by k loop
    continue when col = any(ignored);
    -- On an insert a blank column is not a change; on a delete neither is a blank old value.
    continue when tg_op = 'INSERT' and jsonb_typeof(n -> col) = 'null';
    continue when tg_op = 'DELETE' and jsonb_typeof(o -> col) = 'null';
    continue when (o -> col) is not distinct from (n -> col);

    fields := array_append(fields, col);
    if col = any(masked) then
      hidden := array_append(hidden, col);
    else
      if tg_op <> 'INSERT' then old_diff := old_diff || jsonb_build_object(col, o -> col); end if;
      if tg_op <> 'DELETE' then new_diff := new_diff || jsonb_build_object(col, n -> col); end if;
    end if;
  end loop;

  if array_length(fields, 1) is null then
    return null;
  end if;

  -- Best-effort actor from the PostgREST request headers, exactly as the salary trigger reads it.
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
    v_login := nullif(headers ->> 'x-phoenix-actor-login-id', '');
    v_hr    := nullif(headers ->> 'x-phoenix-actor-hr-id', '');
  exception when others then
    v_login := null;
    v_hr    := null;
  end;

  insert into public.employee_change_log (
    employee_hr_id, change_kind, actor_login_id, actor_hr_id, actor_source,
    changed_fields, masked_fields, old_values, new_values
  ) values (
    v_hr_id, lower(tg_op), v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' else 'unattributed' end,
    fields, hidden, old_diff, new_diff
  );

  return null;
end;
$$;

comment on function public.phx_log_employee_change() is
  'AFTER ROW trigger on public.employees: writes public.employee_change_log. Values of the '
  'columns in its masked list are never stored, only named.';

revoke execute on function public.phx_log_employee_change() from public, anon, authenticated;
grant execute on function public.phx_log_employee_change() to service_role;

drop trigger if exists phx_employees_change_log on public.employees;
create trigger phx_employees_change_log
  after insert or update or delete on public.employees
  for each row execute function public.phx_log_employee_change();

-- ---------------------------------------------------------------- the readable timeline

create or replace view public.v_employee_change_log
with (security_invoker = true) as
  select
    l.id,
    l.changed_at,
    l.change_kind,
    l.employee_hr_id,
    e.full_name as employee_name,
    l.actor_login_id,
    l.actor_hr_id,
    a.full_name as actor_name,
    l.actor_source,
    l.changed_fields,
    l.masked_fields,
    l.old_values,
    l.new_values
  from public.employee_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, l.actor_login_id);

revoke all on public.v_employee_change_log from public, anon, authenticated;
grant select on public.v_employee_change_log to service_role;

commit;

-- Timestamp 20261113151738 was minted to sort after every migration already on main.

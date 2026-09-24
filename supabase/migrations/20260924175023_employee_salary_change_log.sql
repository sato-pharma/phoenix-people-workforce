-- ─────────────────────────────────────────────────────────────────────────────
-- A tamper-evident audit trail for salary changes on public.employees.
--
-- WHAT
--   * public.employee_salary_change_log — one row per salary edit, holding the
--     changed fields as old→new jsonb, when it happened, and who did it.
--   * public.phx_log_employee_salary_change() — AFTER UPDATE trigger on employees
--     that records a row whenever any salary column actually changes.
--   * public.v_employee_salary_change_log — a readable timeline that resolves the
--     employee and actor to their names.
--
-- WHY
--   Salary fields (base/basic/gross/net, allowances, statutory figures) were being
--   overwritten directly on the employees row with NO history anywhere — no
--   trigger, no audit_logs entity, no employee_history row. When a net salary
--   silently differed from what was set up (HR-009, Sep 2026), the database could
--   not say who changed it or when. This closes that blind spot for every future
--   edit — including out-of-band writes (raw SQL / MCP), which are recorded with a
--   null actor precisely so an unattributed change stands out.
--
--   The actor cannot be discovered DB-side: employee writes use the service-role
--   client, so auth.uid() is null. The app therefore passes the acting user on the
--   PostgREST call as the header x-phoenix-actor-login-id / x-phoenix-actor-hr-id,
--   which the trigger reads back via current_setting('request.headers'). Verified
--   on staging that PostgREST forwards these headers into that GUC.
--
-- ROLLBACK
--   drop view if exists public.v_employee_salary_change_log;
--   drop trigger if exists phx_employees_salary_change_log on public.employees;
--   drop function if exists public.phx_log_employee_salary_change();
--   drop table if exists public.employee_salary_change_log;
--   (No data is coerced or dropped; this is purely additive.)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.employee_salary_change_log (
  id             uuid primary key default gen_random_uuid(),
  employee_hr_id text        not null,
  changed_at     timestamptz not null default now(),
  actor_login_id text,
  actor_hr_id    text,
  actor_source   text        not null default 'unattributed',
  changed_fields text[]      not null default '{}',
  old_values     jsonb       not null default '{}'::jsonb,
  new_values     jsonb       not null default '{}'::jsonb
);

comment on table public.employee_salary_change_log is
  'Append-only audit of salary-column changes on public.employees. Written by the '
  'phx_log_employee_salary_change trigger. actor_* is populated from the '
  'x-phoenix-actor-* PostgREST headers the app sends; a null actor means an '
  'out-of-band write (raw SQL / MCP / an unwired code path).';

create index if not exists employee_salary_change_log_hr_id_changed_at_idx
  on public.employee_salary_change_log (employee_hr_id, changed_at desc);

-- Audit table: application-scoped, read via the service-role client only. Enable
-- RLS with no permissive policy so anon/authenticated cannot read it through the
-- public anon key; service_role bypasses RLS.
alter table public.employee_salary_change_log enable row level security;
revoke all on public.employee_salary_change_log from anon, authenticated;
grant select, insert on public.employee_salary_change_log to service_role;

-- SECURITY DEFINER so the row is always written regardless of the invoking role's
-- privileges — the audit must never depend on, nor be blocked by, who did the
-- update. It is a trigger function, never called directly; EXECUTE is revoked from
-- public/anon/authenticated anyway (triggers fire without EXECUTE privilege).
create or replace function public.phx_log_employee_salary_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  salary_cols constant text[] := array[
    'base_salary', 'basic_salary', 'gross_salary', 'net_salary',
    'fuel_allowance', 'extra_cost_of_living', 'medical_insurance',
    'social_insurance', 'taxes', 'social_insurance_wage'
  ];
  o           jsonb := to_jsonb(old);
  n           jsonb := to_jsonb(new);
  col         text;
  old_diff    jsonb := '{}'::jsonb;
  new_diff    jsonb := '{}'::jsonb;
  fields      text[] := '{}';
  headers     json;
  v_login     text;
  v_hr        text;
begin
  foreach col in array salary_cols loop
    if (o ->> col) is distinct from (n ->> col) then
      old_diff := old_diff || jsonb_build_object(col, o -> col);
      new_diff := new_diff || jsonb_build_object(col, n -> col);
      fields   := array_append(fields, col);
    end if;
  end loop;

  -- Nothing salary-related changed on this UPDATE — record nothing.
  if array_length(fields, 1) is null then
    return new;
  end if;

  -- Best-effort actor from the PostgREST request headers. Absent on direct SQL /
  -- MCP writes, which is the point: a null actor flags an out-of-band change.
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
    v_login := nullif(headers ->> 'x-phoenix-actor-login-id', '');
    v_hr    := nullif(headers ->> 'x-phoenix-actor-hr-id', '');
  exception when others then
    v_login := null;
    v_hr    := null;
  end;

  insert into public.employee_salary_change_log (
    employee_hr_id, actor_login_id, actor_hr_id, actor_source,
    changed_fields, old_values, new_values
  ) values (
    new.hr_id, v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' else 'unattributed' end,
    fields, old_diff, new_diff
  );

  return new;
end;
$$;

revoke execute on function public.phx_log_employee_salary_change() from public, anon, authenticated;
grant execute on function public.phx_log_employee_salary_change() to service_role;

drop trigger if exists phx_employees_salary_change_log on public.employees;
create trigger phx_employees_salary_change_log
  after update of
    base_salary, basic_salary, gross_salary, net_salary,
    fuel_allowance, extra_cost_of_living, medical_insurance,
    social_insurance, taxes, social_insurance_wage
  on public.employees
  for each row
  execute function public.phx_log_employee_salary_change();

-- A readable timeline. security_invoker so any non-service caller is still bound by
-- the base tables' RLS; not granted to anon/authenticated.
create or replace view public.v_employee_salary_change_log
with (security_invoker = true) as
  select
    l.id,
    l.changed_at,
    l.employee_hr_id,
    e.full_name          as employee_name,
    l.actor_login_id,
    a.full_name          as actor_name,
    l.actor_source,
    l.changed_fields,
    l.old_values,
    l.new_values
  from public.employee_salary_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, l.actor_login_id)
  order by l.changed_at desc;

grant select on public.v_employee_salary_change_log to service_role;

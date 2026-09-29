-- salary_change_log_covers_new_hires
--
-- WHAT THIS CHANGES:
--   `phx_employees_salary_change_log` fires on INSERT as well as UPDATE, and
--   `phx_log_employee_salary_change()` learns to describe a hire. Nothing else moves: the table,
--   its RLS, its grants, the view and the actor-header logic are all untouched.
--
-- WHY:
--   The log has been live since 20260924175023 and holds ZERO rows. Most of that is innocent — it
--   is five days old and fires only when a salary value actually CHANGES — but one part is not: the
--   trigger was `after update of …`, so an INSERT was never covered and **the salary a person is
--   created with was never recorded at all**.
--
--   Measured on production 2026-09-29: Farah Mossad Elshikh (AI-0022, net 18,000) and Mariam Younan
--   Gaber (AI-0023, net 17,500) were both created on 27 September — after the trigger existed — each
--   with a full salary set at insert, and the audit trail has nothing to say about either. That is
--   precisely the blind spot the original migration was written to close: its own header says the
--   database "could not say who changed it or when", and for a new hire it still could not.
--
--   It matters more from today: the Add Employee form now pre-fills the whole salary chain from an
--   accepted offer (#4761), so new hires increasingly arrive with a complete salary set in one
--   INSERT — the one path the log did not watch.
--
-- HOW A HIRE IS TOLD APART FROM A RAISE:
--   `old_values` is EMPTY (`{}`) on a hire and populated on a change. That is the whole convention,
--   and it is why the insert branch does not write a map of nulls: `{"net_salary": null}` reads like
--   somebody cleared a salary, which is a different and alarming event.
--
--   A hire with no salary logs NOTHING, exactly as before — `changed_fields` carries only the
--   columns that actually arrived with a value. Jonia Wageh and Esraa Awad, created 20 September
--   with every salary box empty, would produce no row under this rule either.
--
-- ROLLBACK:
--   Re-apply 20260924175023's own function and trigger definitions verbatim; they are unchanged by
--   this file except for the two edits described above. No data is written, coerced or dropped —
--   this only changes what is recorded from now on.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: no row is read, rewritten or deleted, and no existing log row is touched.

begin;

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
  is_insert   constant boolean := tg_op = 'INSERT';
  -- ASSIGNED IN THE BODY, never in this DECLARE block. On an INSERT the OLD record is unassigned,
  -- and `to_jsonb(old)` here would raise before the first statement ran — turning an audit trigger
  -- into something that refuses hires.
  o           jsonb;
  n           jsonb := to_jsonb(new);
  col         text;
  old_diff    jsonb := '{}'::jsonb;
  new_diff    jsonb := '{}'::jsonb;
  fields      text[] := '{}';
  headers     json;
  v_login     text;
  v_hr        text;
begin
  o := case when is_insert then '{}'::jsonb else to_jsonb(old) end;

  foreach col in array salary_cols loop
    if is_insert then
      -- A hire records what it ARRIVED with. A column that came in null is not an event: it is a
      -- box nobody filled, and the row would read as "salary set to nothing".
      if (n ->> col) is not null then
        new_diff := new_diff || jsonb_build_object(col, n -> col);
        fields   := array_append(fields, col);
      end if;
    elsif (o ->> col) is distinct from (n ->> col) then
      old_diff := old_diff || jsonb_build_object(col, o -> col);
      new_diff := new_diff || jsonb_build_object(col, n -> col);
      fields   := array_append(fields, col);
    end if;
  end loop;

  -- Nothing salary-related on this write — a hire with no salary, or an edit that touched
  -- something else. Record nothing.
  if array_length(fields, 1) is null then
    return new;
  end if;

  -- Best-effort actor from the PostgREST request headers. Absent on direct SQL / MCP writes, which
  -- is the point: a null actor flags an out-of-band change.
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

-- `of <columns>` binds to UPDATE only; INSERT fires for every new row and the function decides
-- whether anything is worth recording. That asymmetry is intended: a hire has no "columns that
-- changed" to filter on.
drop trigger if exists phx_employees_salary_change_log on public.employees;
create trigger phx_employees_salary_change_log
  after insert or update of
    base_salary, basic_salary, gross_salary, net_salary,
    fuel_allowance, extra_cost_of_living, medical_insurance,
    social_insurance, taxes, social_insurance_wage
  on public.employees
  for each row
  execute function public.phx_log_employee_salary_change();

comment on table public.employee_salary_change_log is
  'Append-only audit of salary changes on public.employees. Written by the '
  'phx_log_employee_salary_change trigger on INSERT and UPDATE. An EMPTY old_values means a HIRE — '
  'the salary the person was created with; a populated old_values is a change to an existing one. '
  'actor_* comes from the x-phoenix-actor-* PostgREST headers the app sends; a null actor means an '
  'out-of-band write (raw SQL / MCP / an unwired code path).';

commit;

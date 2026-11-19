-- change_logs_name_the_scheduled_job — a change a scheduled job makes is logged under the job's name
--
-- WHAT THIS CHANGES:
--   * public.employee_change_log and public.employee_salary_change_log each gain one column,
--     actor_job: the name of the scheduled job that made the write ('cron/probation-milestones',
--     'cron/daily/resignation-sla', 'notifications/daily', ...), at most 100 characters. The app
--     sends it in a new request header, x-phoenix-actor-job, on every database write a job makes
--     (src/lib/supabase/request-actor.ts; the job is the name every scheduled route already gives
--     the shared cron guard, src/lib/security/cron-auth.ts).
--   * actor_source gains a third value, 'job': no person was named, a job was. The record log's
--     CHECK is widened to ('app', 'job', 'unattributed'); the salary log has no CHECK on it.
--   * public.phx_log_employee_change() and public.phx_log_employee_salary_change() read the new
--     header beside the two person headers, and write actor_job and the new actor_source. A person
--     and a job are never mixed: when a person header is set the job is dropped and the row is the
--     person's, exactly as before. Everything else in both bodies is 20261119035258's, word for word.
--   * public.v_employee_change_log and public.v_employee_salary_change_log show actor_job, appended
--     at the end (CREATE OR REPLACE VIEW can only append); every join and grant is unchanged.
--
-- WHY (owner, 19 Nov 2026: "Name scheduled jobs"):
--   The Employee Master's Change History panel reads "No person recorded" for every change a
--   scheduled job makes — the morning resignation job ending an exit, a probation run, a hiring
--   reconcile — because a job has no signed-in person and sent nothing. The panel now names the job.
--
-- WHAT IS NEVER STORED: still no request header VALUE other than the three actor headers.
--   The job name is the app's own fixed route name, never a token.
--
-- ROWS WRITTEN BEFORE THIS MIGRATION keep actor_job NULL (both logs are append-only). A NULL means
--   "no job was named", which on an old row is unknown.
--
-- SIDE EFFECTS: none on an employee write — the header is read inside the existing exception
--   block. Adding a nullable column rewrites nothing. Re-adding the CHECK reads the record log's
--   rows once (about 150) to validate them; every one is 'app' or 'unattributed'.
--
-- ROLLBACK (the column can stay; restoring the old bodies stops filling it):
--   re-run phx_log_employee_change() and phx_log_employee_salary_change() from
--   20261119035258_change_logs_record_the_write_channel.sql, then
--     alter table public.employee_change_log drop constraint employee_change_log_actor_source_check;
--     alter table public.employee_change_log add constraint employee_change_log_actor_source_check
--       check (actor_source in ('app', 'unattributed'));
--   (only once no row reads 'job'). A view cannot lose a column by CREATE OR REPLACE: rolling the
--   views back is a drop and re-create of each with its 20261119035258 / 20261119111338 definition,
--   then revoke all from public, anon, authenticated and grant select to service_role.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: no existing row is rewritten or deleted.

begin;

-- ---------------------------------------------------------------- the column

alter table public.employee_change_log
  add column if not exists actor_job text;

alter table public.employee_salary_change_log
  add column if not exists actor_job text;

comment on column public.employee_change_log.actor_job is
  'The scheduled job that made the write (its cron route name, at most 100 characters), when no '
  'person was named. Read from the x-phoenix-actor-job request header. NULL = no job named.';
comment on column public.employee_salary_change_log.actor_job is
  'The scheduled job that made the write (its cron route name, at most 100 characters), when no '
  'person was named. Read from the x-phoenix-actor-job request header. NULL = no job named.';

alter table public.employee_change_log
  drop constraint if exists employee_change_log_actor_source_check;
alter table public.employee_change_log
  add constraint employee_change_log_actor_source_check
  check (actor_source in ('app', 'job', 'unattributed'));

-- ---------------------------------------------------------------- the employee log's writer

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
    'residence_address', 'birth_date',
    'residence_city', 'residence_area', 'birth_place',
    'kaab_elamaal_issuer', 'kaab_elamaal_issue_date', 'kaab_elamaal_refund',
    'cv_path', 'cv_file_name', 'photo_path',
    'exit_reason', 'bank_name'
  ];
  o          jsonb := '{}'::jsonb;
  n          jsonb := '{}'::jsonb;
  col        text;
  fields     text[] := '{}';
  hidden     text[] := '{}';
  old_diff   jsonb := '{}'::jsonb;
  new_diff   jsonb := '{}'::jsonb;
  v_hr_id    text;
  headers    json;
  v_login    text;
  v_hr       text;
  v_job      text;
  v_channel  text;
  v_api_role text;
  v_api_path text;
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

  -- Best-effort actor from the PostgREST request headers, exactly as the salary trigger reads it:
  -- the signed-in person, or, when a scheduled job made the write, the job's name.
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
    v_login := nullif(headers ->> 'x-phoenix-actor-login-id', '');
    v_hr    := nullif(headers ->> 'x-phoenix-actor-hr-id', '');
    v_job   := left(nullif(btrim(headers ->> 'x-phoenix-actor-job'), ''), 100);
  exception when others then
    v_login := null;
    v_hr    := null;
    v_job   := null;
  end;
  -- A person and a job are never mixed into one actor: a named person owns the row.
  if v_login is not null or v_hr is not null then
    v_job := null;
  end if;

  -- HOW the write arrived, from the session itself. PostgREST sets request.jwt.claims and
  -- request.headers on every request; a direct session sets neither. Only WHETHER the headers are
  -- set is read here: their values carry the API key.
  v_channel := case
    when coalesce(current_setting('request.jwt.claims', true), '') <> ''
      or coalesce(current_setting('request.headers', true), '') <> '' then 'api'
    when coalesce(current_setting('application_name', true), '') like 'pg\_cron%' then 'database_job'
    else 'direct_sql'
  end;
  if v_channel = 'api' then
    begin
      v_api_role := left(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', 64);
    exception when others then
      v_api_role := null;
    end;
    v_api_path := left(nullif(current_setting('request.path', true), ''), 200);
  end if;

  insert into public.employee_change_log (
    employee_hr_id, change_kind, actor_login_id, actor_hr_id, actor_source,
    changed_fields, masked_fields, old_values, new_values,
    write_channel, write_db_user, write_application, write_api_role, write_api_path, actor_job
  ) values (
    v_hr_id, lower(tg_op), v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' when v_job is not null then 'job' else 'unattributed' end,
    fields, hidden, old_diff, new_diff,
    v_channel, session_user::text,
    left(nullif(current_setting('application_name', true), ''), 64),
    v_api_role, v_api_path, v_job
  );

  return null;
end;
$$;

revoke execute on function public.phx_log_employee_change() from public, anon, authenticated;
grant execute on function public.phx_log_employee_change() to service_role;

-- ---------------------------------------------------------------- the salary log's writer

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
  v_job       text;
  v_channel   text;
  v_api_role  text;
  v_api_path  text;
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

  -- Best-effort actor from the PostgREST request headers: the signed-in person, or, when a
  -- scheduled job made the write, the job's name. Absent on direct SQL / MCP writes, which is the
  -- point: a null actor flags an out-of-band change.
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
    v_login := nullif(headers ->> 'x-phoenix-actor-login-id', '');
    v_hr    := nullif(headers ->> 'x-phoenix-actor-hr-id', '');
    v_job   := left(nullif(btrim(headers ->> 'x-phoenix-actor-job'), ''), 100);
  exception when others then
    v_login := null;
    v_hr    := null;
    v_job   := null;
  end;
  -- A person and a job are never mixed into one actor: a named person owns the row.
  if v_login is not null or v_hr is not null then
    v_job := null;
  end if;

  -- HOW the write arrived, read exactly as the employee log reads it. Only WHETHER the headers
  -- are set is read: their values carry the API key.
  v_channel := case
    when coalesce(current_setting('request.jwt.claims', true), '') <> ''
      or coalesce(current_setting('request.headers', true), '') <> '' then 'api'
    when coalesce(current_setting('application_name', true), '') like 'pg\_cron%' then 'database_job'
    else 'direct_sql'
  end;
  if v_channel = 'api' then
    begin
      v_api_role := left(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', 64);
    exception when others then
      v_api_role := null;
    end;
    v_api_path := left(nullif(current_setting('request.path', true), ''), 200);
  end if;

  insert into public.employee_salary_change_log (
    employee_hr_id, actor_login_id, actor_hr_id, actor_source,
    changed_fields, old_values, new_values,
    write_channel, write_db_user, write_application, write_api_role, write_api_path, actor_job
  ) values (
    new.hr_id, v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' when v_job is not null then 'job' else 'unattributed' end,
    fields, old_diff, new_diff,
    v_channel, session_user::text,
    left(nullif(current_setting('application_name', true), ''), 64),
    v_api_role, v_api_path, v_job
  );

  return new;
end;
$$;

revoke execute on function public.phx_log_employee_salary_change() from public, anon, authenticated;
grant execute on function public.phx_log_employee_salary_change() to service_role;

-- ---------------------------------------------------------------- the readable timelines

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
    l.new_values,
    l.write_channel,
    l.write_db_user,
    l.write_application,
    l.write_api_role,
    l.write_api_path,
    l.actor_job
  from public.employee_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.app_auth_users u on l.actor_hr_id is null and u.login_id = l.actor_login_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, u.hr_id);

revoke all on public.v_employee_change_log from public, anon, authenticated;
grant select on public.v_employee_change_log to service_role;

create or replace view public.v_employee_salary_change_log
with (security_invoker = true) as
  select
    l.id,
    l.changed_at,
    l.employee_hr_id,
    e.full_name as employee_name,
    l.actor_login_id,
    a.full_name as actor_name,
    l.actor_source,
    l.changed_fields,
    l.old_values,
    l.new_values,
    l.write_channel,
    l.write_db_user,
    l.write_application,
    l.write_api_role,
    l.write_api_path,
    l.actor_hr_id,
    l.actor_job
  from public.employee_salary_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, l.actor_login_id)
  order by l.changed_at desc;

revoke all on public.v_employee_salary_change_log from public, anon, authenticated;
grant select on public.v_employee_salary_change_log to service_role;

commit;

-- Timestamp 20261119132416 was minted to sort after every migration already on main.

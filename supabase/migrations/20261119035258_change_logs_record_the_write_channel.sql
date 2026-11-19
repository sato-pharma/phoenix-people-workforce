-- change_logs_record_the_write_channel — the employee and salary logs record HOW a change arrived
--
-- WHAT THIS CHANGES:
--   * public.employee_change_log and public.employee_salary_change_log each gain five columns,
--     filled by their triggers from what Postgres itself knows about the session:
--       write_channel     'api'          — a PostgREST request (the app, a script using the
--                                          Supabase client, an edge function): PostgREST sets
--                                          request.jwt.claims and request.headers on every call;
--                         'database_job' — a pg_cron job (application_name pg_cron…);
--                         'direct_sql'   — any other direct session: the SQL editor, the
--                                          management API the MCP uses (mgmt-api), psql,
--                                          scripts/apply-sql-file.mjs, a migration.
--       write_db_user     session_user — the role that logged in (authenticator = PostgREST,
--                                        postgres = a direct session). current_user is NOT
--                                        recorded: inside these SECURITY DEFINER triggers it is
--                                        always the function owner and says nothing.
--       write_application application_name, at most 64 characters ('PostgREST 14.5',
--                                        'mgmt-api', 'pg_cron', 'Supavisor', a script's own name).
--       write_api_role    on an api write only: the JWT's role claim (service_role, …).
--       write_api_path    on an api write only: the PostgREST path ('/employees',
--                                        '/rpc/<function>'), at most 200 characters — which code
--                                        path made the write.
--   * public.phx_log_employee_change() and public.phx_log_employee_salary_change() write them.
--     Everything else in both bodies is unchanged: the masked list, the ignored list, the actor
--     read and the insert/update/delete rules are copied from 20261114024807 and 20260929183329.
--   * public.v_employee_change_log and public.v_employee_salary_change_log show the five columns,
--     appended at the end (CREATE OR REPLACE VIEW can only append); every join is unchanged.
--
-- WHY (database review, 19 Nov 2026):
--   71 of the 100 employee_change_log rows written since 13 Nov 14:08 UTC name nobody
--   (actor_source 'unattributed'): the 13 Nov historical-leaver inserts and name updates, a 14 Nov
--   bulk of 33 bank-detail updates, and six single edits. "Unattributed" today means only "no
--   x-phoenix-actor-* header", so the log cannot tell an app write that FORGOT the header from a
--   job, a script or a direct SQL session. With the channel, an unattributed 'api' row on an
--   app path is a forgotten header to chase, and a 'direct_sql' row is an out-of-band change.
--   The salary log has the same gap (7 of 73 rows unattributed on 19 Nov), so it gets the same.
--
-- WHAT IS NEVER STORED: no request header VALUE. request.headers carries the API key and the
--   bearer token, so the triggers only ask whether it is set; from request.jwt.claims they take
--   the role claim alone. request.path is the path without its query string.
--
-- ROWS WRITTEN BEFORE THIS MIGRATION keep the five columns NULL: both logs are append-only (an
--   UPDATE is refused by trigger), and nobody can know now how an old write arrived. NULL means
--   "not recorded", never a channel.
--
-- SIDE EFFECTS: none on an employee write — the context is read with current_setting(..., true),
--   which never raises, and the one JSON parse is inside its own exception block. Adding nullable
--   columns with no default rewrites nothing and fires no trigger.
--
-- ROLLBACK (the columns can stay; restoring the old bodies stops filling them):
--   re-run phx_log_employee_change() and v_employee_change_log from
--   20261114024807_restore_without_triggers_and_actor_from_the_request.sql and
--   20261114020715_history_and_undo_log_review_fixes.sql, and phx_log_employee_salary_change()
--   from 20260929183329_salary_change_log_covers_new_hires.sql. A view cannot lose columns by
--   CREATE OR REPLACE: rolling the views back is a drop and re-create of each view with its
--   20261114020715 / 20260924175023 definition and grants.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: no existing row is read, rewritten or deleted.

begin;

-- ---------------------------------------------------------------- the columns

alter table public.employee_change_log
  add column if not exists write_channel     text,
  add column if not exists write_db_user     text,
  add column if not exists write_application text,
  add column if not exists write_api_role    text,
  add column if not exists write_api_path    text;

alter table public.employee_salary_change_log
  add column if not exists write_channel     text,
  add column if not exists write_db_user     text,
  add column if not exists write_application text,
  add column if not exists write_api_role    text,
  add column if not exists write_api_path    text;

-- A NULL passes a CHECK, which is what the rows written before today need; the triggers below
-- always set one of the three values.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'employee_change_log_write_channel_check'
                   and conrelid = 'public.employee_change_log'::regclass) then
    alter table public.employee_change_log
      add constraint employee_change_log_write_channel_check
      check (write_channel in ('api', 'database_job', 'direct_sql'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'employee_salary_change_log_write_channel_check'
                   and conrelid = 'public.employee_salary_change_log'::regclass) then
    alter table public.employee_salary_change_log
      add constraint employee_salary_change_log_write_channel_check
      check (write_channel in ('api', 'database_job', 'direct_sql'));
  end if;
end;
$$;

comment on column public.employee_change_log.write_channel is
  'How the write reached the database: api (a PostgREST request), database_job (pg_cron) or '
  'direct_sql (any other direct session). NULL on rows written before 19 Nov 2026 = not recorded.';
comment on column public.employee_change_log.write_db_user is
  'session_user of the write: authenticator for PostgREST, postgres for a direct session.';
comment on column public.employee_change_log.write_application is
  'application_name of the write''s session, at most 64 characters.';
comment on column public.employee_change_log.write_api_role is
  'On an api write only: the role claim of the request''s JWT. No token or header value is stored.';
comment on column public.employee_change_log.write_api_path is
  'On an api write only: the PostgREST path (/employees, /rpc/<function>), at most 200 characters.';

comment on column public.employee_salary_change_log.write_channel is
  'How the write reached the database: api (a PostgREST request), database_job (pg_cron) or '
  'direct_sql (any other direct session). NULL on rows written before 19 Nov 2026 = not recorded.';
comment on column public.employee_salary_change_log.write_db_user is
  'session_user of the write: authenticator for PostgREST, postgres for a direct session.';
comment on column public.employee_salary_change_log.write_application is
  'application_name of the write''s session, at most 64 characters.';
comment on column public.employee_salary_change_log.write_api_role is
  'On an api write only: the role claim of the request''s JWT. No token or header value is stored.';
comment on column public.employee_salary_change_log.write_api_path is
  'On an api write only: the PostgREST path (/employees, /rpc/<function>), at most 200 characters.';

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

  -- Best-effort actor from the PostgREST request headers, exactly as the salary trigger reads it.
  begin
    headers := nullif(current_setting('request.headers', true), '')::json;
    v_login := nullif(headers ->> 'x-phoenix-actor-login-id', '');
    v_hr    := nullif(headers ->> 'x-phoenix-actor-hr-id', '');
  exception when others then
    v_login := null;
    v_hr    := null;
  end;

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
    write_channel, write_db_user, write_application, write_api_role, write_api_path
  ) values (
    v_hr_id, lower(tg_op), v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' else 'unattributed' end,
    fields, hidden, old_diff, new_diff,
    v_channel, session_user::text,
    left(nullif(current_setting('application_name', true), ''), 64),
    v_api_role, v_api_path
  );

  return null;
end;
$$;

comment on function public.phx_log_employee_change() is
  'AFTER ROW trigger on public.employees: writes public.employee_change_log. Values of the '
  'columns in its masked list are never stored, only named. write_channel says how the write '
  'arrived (api, database_job, direct_sql).';

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
    write_channel, write_db_user, write_application, write_api_role, write_api_path
  ) values (
    new.hr_id, v_login, v_hr,
    case when v_login is not null or v_hr is not null then 'app' else 'unattributed' end,
    fields, old_diff, new_diff,
    v_channel, session_user::text,
    left(nullif(current_setting('application_name', true), ''), 64),
    v_api_role, v_api_path
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
    l.write_api_path
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
    l.write_api_path
  from public.employee_salary_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, l.actor_login_id)
  order by l.changed_at desc;

revoke all on public.v_employee_salary_change_log from public, anon, authenticated;
grant select on public.v_employee_salary_change_log to service_role;

commit;

-- Timestamp 20261119035258 was minted to sort after every migration already on main.

-- history_and_undo_log_review_fixes — the review of 20261113151738/39/41, fixed forward
--
-- WHAT THIS CHANGES:
--   1. recovery.restore_table() — a restore no longer empties the table and refills it. It deletes
--      only the rows the snapshot does not hold, puts every other row back in place by its primary
--      key (an upsert that touches only rows that differ), and names its columns instead of
--      `select *`. Until now a restore of a table that another table points at with a RESTRICT or
--      NO ACTION key (deductions_candidates, deductions_publications, deductions_decisions,
--      automated_payroll_runs, attendance_settlements — read live on production 2026-11-14) failed
--      on its first statement, because `set constraints all deferred` does not reach a key that is
--      not deferrable; and a table with a generated column (automated_payroll_runs,
--      deductions_candidates, deductions_publications, employee_salary_structure, line_area_map)
--      failed on `select *`. A row that must go and is still referenced now fails loudly, naming the
--      key, which is right: it cannot vanish without its children.
--   2. public.phx_log_deduction_decision_change() — an untouched placeholder (Pending, no decider, no
--      reason, no note, no amounts, no dates) is no longer logged as 'decision_recorded'. service.ts
--      inserts one for every new candidate, so every candidate was getting a fake decision row, and
--      with deductions_audit.candidate_id ON DELETE RESTRICT, could never be deleted again. A DELETE
--      of a real decision is now logged as 'decision_deleted' (a placeholder's delete is not), by a
--      second trigger, phx_deductions_decisions_history_delete.
--   3. public.phx_log_employee_change() — nine more columns are named and never valued:
--      residence_city, residence_area, birth_place, kaab_elamaal_issuer, kaab_elamaal_issue_date,
--      kaab_elamaal_refund, cv_path, cv_file_name, photo_path. None had been logged yet (0 rows on
--      production, read 2026-11-14).
--   4. public.v_employee_change_log — the actor is resolved through app_auth_users.login_id when no
--      actor hr id was sent. The login id is not an hr id ("ops:…" logins today), so the old
--      coalesce named nobody, or the wrong person.
--
-- WHY: the code review of 2026-11-14 on the three migrations of 2026-11-13.
--
-- ROLLBACK: re-run the bodies of 20261113151738 (phx_log_employee_change, v_employee_change_log),
--   20261113151739 (phx_log_deduction_decision_change) and 20260929203100 (recovery.restore_table),
--   and  drop trigger if exists phx_deductions_decisions_history_delete on public.deductions_decisions;
--   The deductions_audit rows written meanwhile stay: that table is append-only by design.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it replaces three functions and a view, and adds one trigger.

begin;

-- ---------------------------------------------------------------- 1. the restore merges by key

create or replace function recovery.restore_table(
  p_schema  text,
  p_table   text,
  p_as_of   timestamptz,
  p_dry_run boolean default true
)
returns table (
  snapshot_id       bigint,
  snapshot_taken_at timestamptz,
  rows_now          integer,
  rows_in_snapshot  integer,
  applied           boolean,
  note              text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_snap     record;
  v_pk       text[];
  v_now_rows integer;
  v_pre      jsonb;
  v_rel      regclass;
  v_insert   text;   -- every column a row can be given: not dropped, not generated
  v_update   text[]; -- what an update may set: those, less the key and GENERATED ALWAYS identities
  v_pk_list  text;
  v_pk_t     text;
  v_pk_s     text;
  v_deleted  integer;
  v_written  integer;
begin
  select pt.pk_columns into v_pk
  from recovery.protected_tables pt
  where pt.source_schema = p_schema and pt.source_table = p_table;

  if v_pk is null then
    raise exception 'recovery.restore_table: %.% is not a protected table', p_schema, p_table;
  end if;

  -- "The state at time T" is the newest snapshot AT OR BEFORE T. Because unchanged hours write
  -- nothing, the gaps are correct rather than missing: no snapshot between two points means the
  -- table did not change between them.
  select s.id, s.taken_at, s.row_count, s.payload
  into v_snap
  from recovery.table_snapshots s
  where s.source_schema = p_schema and s.source_table = p_table and s.taken_at <= p_as_of
  order by s.taken_at desc, s.id desc
  limit 1;

  if v_snap.id is null then
    raise exception 'recovery.restore_table: no snapshot of %.% at or before %', p_schema, p_table, p_as_of;
  end if;

  execute format('select count(*)::integer from %I.%I', p_schema, p_table) into v_now_rows;

  if p_dry_run then
    return query select v_snap.id, v_snap.taken_at, v_now_rows, v_snap.row_count, false,
      format('DRY RUN. Would put %s live row(s) back to the %s row(s) of %s: rows the snapshot does '
             'not hold are deleted, every other row is restored in place by its key. Re-run with '
             'p_dry_run => false to apply. A pre-image is taken automatically.',
             v_now_rows, v_snap.row_count, v_snap.taken_at)::text;
    return;
  end if;

  -- Mandatory undo for the undo. There is no PITR behind a restore that was the wrong call.
  v_pre := recovery.canonical_payload(p_schema, p_table, v_pk);
  insert into recovery.restore_preimages (source_schema, source_table, payload, restored_to_snapshot_id)
  values (p_schema, p_table, v_pre, v_snap.id);

  v_rel := format('%I.%I', p_schema, p_table)::regclass;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         array_agg(quote_ident(a.attname) order by a.attnum)
           filter (where a.attidentity <> 'a' and a.attname <> all (v_pk))
    into v_insert, v_update
    from pg_attribute a
   where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  select string_agg(quote_ident(c), ', '),
         string_agg('t.' || quote_ident(c), ', '),
         string_agg('s.' || quote_ident(c), ', ')
    into v_pk_list, v_pk_t, v_pk_s
    from unnest(v_pk) as c;

  -- Not an empty-and-refill: a key that is not deferrable (every RESTRICT, and NO ACTION unless
  -- declared deferrable) refuses the first statement of that, whatever `set constraints` says. Only
  -- the rows the snapshot lacks are deleted; a referenced one among them still refuses, by name.
  set constraints all deferred;
  execute format(
    'delete from %I.%I t where not exists ('
    'select 1 from jsonb_populate_recordset(null::%I.%I, $1) s where (%s) = (%s))',
    p_schema, p_table, p_schema, p_table, v_pk_t, v_pk_s) using v_snap.payload;
  get diagnostics v_deleted = row_count;

  -- Every other row back in place by its key; a row already equal is not touched, so no trigger
  -- fires for it.
  if coalesce(array_length(v_update, 1), 0) = 0 then
    execute format(
      'insert into %I.%I as t (%s) overriding system value '
      'select %s from jsonb_populate_recordset(null::%I.%I, $1) on conflict (%s) do nothing',
      p_schema, p_table, v_insert, v_insert, p_schema, p_table, v_pk_list) using v_snap.payload;
  else
    execute format(
      'insert into %I.%I as t (%s) overriding system value '
      'select %s from jsonb_populate_recordset(null::%I.%I, $1) on conflict (%s) do update '
      'set (%s) = row(%s) where row(%s)::text is distinct from row(%s)::text',
      p_schema, p_table, v_insert, v_insert, p_schema, p_table, v_pk_list,
      array_to_string(v_update, ', '),
      (select string_agg('excluded.' || c, ', ') from unnest(v_update) as c),
      (select string_agg('t.' || c, ', ') from unnest(v_update) as c),
      (select string_agg('excluded.' || c, ', ') from unnest(v_update) as c)) using v_snap.payload;
  end if;
  get diagnostics v_written = row_count;

  return query select v_snap.id, v_snap.taken_at, v_now_rows, v_snap.row_count, true,
    format('APPLIED. %s live row(s) put back to the %s row(s) of %s: %s deleted, %s inserted or '
           'restored in place. Pre-image kept in recovery.restore_preimages. Check any identity '
           'sequence before inserting again.',
           v_now_rows, v_snap.row_count, v_snap.taken_at, v_deleted, v_written)::text;
end;
$function$;

revoke execute on function recovery.restore_table(text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function recovery.restore_table(text, text, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------- 2. deduction decisions

-- SECURITY DEFINER so the row is written whoever performs the write. Never called directly.
create or replace function public.phx_log_deduction_decision_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deciding constant text[] := array[
    'decision_status', 'decision_reason', 'hr_note',
    'applied_value', 'applied_amount', 'applied_dates', 'decided_by'
  ];
  o       jsonb := '{}'::jsonb;
  n       jsonb := '{}'::jsonb;
  r       jsonb;
  col     text;
  fields  text[] := '{}';
  before_ jsonb := '{}'::jsonb;
  after_  jsonb := '{}'::jsonb;
  v_actor text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    o := to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    n := to_jsonb(new);
  end if;
  r := case when tg_op = 'DELETE' then o else n end;

  foreach col in array deciding loop
    if tg_op <> 'INSERT' then before_ := before_ || jsonb_build_object(col, o -> col); end if;
    if tg_op <> 'DELETE' then after_  := after_  || jsonb_build_object(col, n -> col); end if;
    if tg_op = 'UPDATE' then
      if (o -> col) is distinct from (n -> col) then
        fields := array_append(fields, col);
      end if;
    -- An insert or a delete counts only what a person filled in. The placeholder service.ts
    -- inserts for every new candidate — Pending, '' reason, '' note, nothing else — is not a
    -- decision, and logging it would hold every candidate by deductions_audit's RESTRICT key.
    elsif coalesce(jsonb_typeof(r -> col), 'null') <> 'null'
          and (r -> col) not in ('""'::jsonb, '[]'::jsonb)
          and not (col = 'decision_status' and r ->> col = 'Pending') then
      fields := array_append(fields, col);
    end if;
  end loop;

  if array_length(fields, 1) is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    -- Nobody decided a delete: the actor is whoever the request names, if anyone.
    begin
      v_actor := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-phoenix-actor-hr-id', '');
    exception when others then
      v_actor := null;
    end;
  else
    v_actor := r ->> 'decided_by';
  end if;

  insert into public.deductions_audit (candidate_id, actor_hr_id, action, detail)
  values (
    (r ->> 'candidate_id')::uuid,
    v_actor,
    case tg_op when 'INSERT' then 'decision_recorded'
               when 'UPDATE' then 'decision_changed'
               else 'decision_deleted' end,
    jsonb_build_object(
      'decision_id', r -> 'id',
      'changed_fields', to_jsonb(fields),
      'before', case when tg_op = 'INSERT' then null else before_ end,
      'after', case when tg_op = 'DELETE' then null else after_ end,
      'decided_at', r -> 'decided_at',
      'actor_role_at_decision', r -> 'actor_role_at_decision'
    )
  );

  return null;
end;
$$;

comment on function public.phx_log_deduction_decision_change() is
  'AFTER INSERT, UPDATE and DELETE row trigger on public.deductions_decisions: appends the decision '
  'before and after to the append-only public.deductions_audit (decision_recorded, '
  'decision_changed, decision_deleted). An untouched Pending placeholder is not logged.';

revoke execute on function public.phx_log_deduction_decision_change() from public, anon, authenticated;
grant execute on function public.phx_log_deduction_decision_change() to service_role;

-- A second trigger, so the guarded phx_deductions_decisions_history is never dropped. A delete
-- arriving by cascade from a candidate whose decision was real is now refused by
-- deductions_audit's RESTRICT key — on purpose: that decision cannot vanish without a trace.
drop trigger if exists phx_deductions_decisions_history_delete on public.deductions_decisions;
create trigger phx_deductions_decisions_history_delete
  after delete on public.deductions_decisions
  for each row execute function public.phx_log_deduction_decision_change();

-- ---------------------------------------------------------------- 3. the employee log's masked list

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
    'residence_address', 'birth_date',
    'residence_city', 'residence_area', 'birth_place',
    'kaab_elamaal_issuer', 'kaab_elamaal_issue_date', 'kaab_elamaal_refund',
    'cv_path', 'cv_file_name', 'photo_path'
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

revoke execute on function public.phx_log_employee_change() from public, anon, authenticated;
grant execute on function public.phx_log_employee_change() to service_role;

-- ---------------------------------------------------------------- 4. the view names the right actor

-- A login id is not an hr id: it becomes one only through app_auth_users.
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
  left join public.app_auth_users u on l.actor_hr_id is null and u.login_id = l.actor_login_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, u.hr_id);

revoke all on public.v_employee_change_log from public, anon, authenticated;
grant select on public.v_employee_change_log to service_role;

commit;

-- Timestamp 20261114020715 was minted to sort after every migration already on main.

-- restore_without_triggers_and_actor_from_the_request — the second review of the history and undo log
--
-- WHAT THIS CHANGES:
--   1. recovery.restore_table() — a restore puts ROWS back; it is not a business event.
--        * While it runs, the table's own triggers and foreign-key actions are held off
--          (session_replication_role = replica, set for the restore's own statements and put back
--          before it returns). No guard refuses it (the reactivation guard on employees, the
--          *_immutable triggers on attendance_settlements and attendance_annual_balance_charges,
--          the closed-month guard on salary_records), nothing is written into another table (a
--          vacancy, a probation case, a CRM person, an audit row), no updated_at is stamped with
--          the restore's time, and nothing cascades. An ENABLE ALWAYS trigger still fires; no
--          protected table has one (read on production 2026-11-14).
--        * It no longer updates rows in place. A row the snapshot does not hold, or holds
--          differently, is removed, and the snapshot's row is inserted. All the removals come
--          first, so a unique value that moved between two surviving rows no longer collides with
--          a row not yet restored (36 of the 50 protected tables have a unique index besides the
--          primary key). A row already equal to the snapshot is not touched at all.
--        * Because the foreign keys were held off, it then checks every foreign key that touches
--          the table, in both directions, and refuses the whole restore — nothing changed — if any
--          row would be left pointing at a row that is not there. The message names the key. So a
--          row that still has children elsewhere is never removed quietly, and never cascades.
--      The pre-image, the dry run and the named columns are unchanged.
--   2. public.phx_log_deduction_decision_change() — who changed a decision is the person the
--      request names (x-phoenix-actor-hr-id), as the employee and salary logs already read it. The
--      row's own decided_by is used only when the request names nobody AND the write is what set
--      it: an insert, or an update that changed decided_by or decided_at. Otherwise the actor is
--      left empty. Until now every update was recorded under the name already stored in the row,
--      so a note edited by someone else read as the original decider changing their own decision.
--   3. public.phx_log_employee_change() — exit_reason and bank_name are named and never valued.
--      A free-text exit reason can be medical or disciplinary, and the log is append-only: a value
--      once stored could never be cleaned. Neither had been logged yet (0 rows on production, read
--      2026-11-14).
--
-- WHY: the code review of 2026-11-14 on 20261114020715.
--
-- ROLLBACK: re-run the three function bodies from 20261114020715_history_and_undo_log_review_fixes.sql.
--   Rows the employee log wrote meanwhile keep exit_reason and bank_name unvalued; that cannot be
--   undone and does not need to be.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it replaces three functions. No row is written.

begin;

-- ---------------------------------------------------------------- 1. the restore puts rows back

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
  v_cols     text;   -- every column a row can be given: not dropped, not generated
  v_t_cols   text;   -- the same, read from the live row
  v_s_cols   text;   -- the same, read from the snapshot row
  v_pk_list  text;
  v_pk_t     text;
  v_pk_s     text;
  v_removed  integer;
  v_inserted integer;
  v_role     text;
  v_fk       record;
  v_orphans  bigint;
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
      format('DRY RUN. Would put %s live row(s) back to the %s row(s) of %s: a row the snapshot does '
             'not hold, or holds differently, is removed and the snapshot''s row inserted, with the '
             'table''s triggers held off. Refused if a row elsewhere would be left pointing at '
             'nothing. Re-run with p_dry_run => false to apply. A pre-image is taken automatically.',
             v_now_rows, v_snap.row_count, v_snap.taken_at)::text;
    return;
  end if;

  -- Mandatory undo for the undo. There is no PITR behind a restore that was the wrong call.
  v_pre := recovery.canonical_payload(p_schema, p_table, v_pk);
  insert into recovery.restore_preimages (source_schema, source_table, payload, restored_to_snapshot_id)
  values (p_schema, p_table, v_pre, v_snap.id);

  v_rel := format('%I.%I', p_schema, p_table)::regclass;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         string_agg('t.' || quote_ident(a.attname), ', ' order by a.attnum),
         string_agg('s.' || quote_ident(a.attname), ', ' order by a.attnum)
    into v_cols, v_t_cols, v_s_cols
    from pg_attribute a
   where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  select string_agg(quote_ident(c), ', '),
         string_agg('t.' || quote_ident(c), ', '),
         string_agg('s.' || quote_ident(c), ', ')
    into v_pk_list, v_pk_t, v_pk_s
    from unnest(v_pk) as c;

  -- A restore puts rows back; it is not a business event. Replica mode holds off the table's own
  -- triggers and the foreign-key actions for the two statements below: no guard refuses them, no
  -- trigger writes elsewhere or stamps updated_at, nothing cascades. It is a SET LOCAL statement
  -- because set_config() is refused for this parameter on Supabase; a failure anywhere below
  -- rolls the setting back with everything else.
  v_role := current_setting('session_replication_role');
  set local session_replication_role = 'replica';

  -- Never an empty-and-refill, and never an update in place. A row the snapshot does not hold, or
  -- holds differently, goes first — every one of them before any row is put back, so a unique
  -- value that moved between two surviving rows cannot collide with a row not yet restored.
  execute format(
    'delete from %I.%I t where not exists ('
    'select 1 from jsonb_populate_recordset(null::%I.%I, $1) s '
    'where (%s) = (%s) and row(%s)::text is not distinct from row(%s)::text)',
    p_schema, p_table, p_schema, p_table, v_pk_t, v_pk_s, v_t_cols, v_s_cols) using v_snap.payload;
  get diagnostics v_removed = row_count;

  -- The snapshot's rows that are not there now. A row left alone above is skipped by its key.
  execute format(
    'insert into %I.%I as t (%s) overriding system value '
    'select %s from jsonb_populate_recordset(null::%I.%I, $1) s on conflict (%s) do nothing',
    p_schema, p_table, v_cols, v_s_cols, p_schema, p_table, v_pk_list) using v_snap.payload;
  get diagnostics v_inserted = row_count;

  execute format('set local session_replication_role = %L', v_role);

  -- The foreign keys were held off, so they are checked here, by hand, in both directions: this
  -- table's rows pointing out, and every other table's rows pointing in. MATCH SIMPLE checks a
  -- row only when all its key columns are set; MATCH FULL when any is.
  for v_fk in
    select c.conname,
           format('%I.%I', cn.nspname, cc.relname) as child,
           format('%I.%I', pn.nspname, pc.relname) as parent,
           (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ' order by k.ord)
              from unnest(c.conkey, c.confkey) with ordinality as k(child_att, parent_att, ord)
              join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.child_att
              join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.parent_att) as same_key,
           (select string_agg(format('c.%I is not null', ca.attname),
                              case when c.confmatchtype = 'f' then ' or ' else ' and ' end order by k.ord)
              from unnest(c.conkey) with ordinality as k(child_att, ord)
              join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.child_att) as key_is_set
      from pg_constraint c
      join pg_class cc on cc.oid = c.conrelid
      join pg_namespace cn on cn.oid = cc.relnamespace
      join pg_class pc on pc.oid = c.confrelid
      join pg_namespace pn on pn.oid = pc.relnamespace
     where c.contype = 'f' and (c.conrelid = v_rel or c.confrelid = v_rel)
     order by c.conname
  loop
    execute format(
      'select count(*) from %s c where (%s) and not exists (select 1 from %s p where %s)',
      v_fk.child, v_fk.key_is_set, v_fk.parent, v_fk.same_key) into v_orphans;
    if v_orphans > 0 then
      raise exception
        'recovery.restore_table: putting %.% back to % would leave % row(s) of % pointing at a row of % that is not there (key %). Nothing was changed.',
        p_schema, p_table, v_snap.taken_at, v_orphans, v_fk.child, v_fk.parent, v_fk.conname
        using errcode = 'foreign_key_violation',
              hint = 'Restore the other table to the same moment in the same transaction, or choose another time.';
    end if;
  end loop;

  return query select v_snap.id, v_snap.taken_at, v_now_rows, v_snap.row_count, true,
    format('APPLIED. %s live row(s) put back to the %s row(s) of %s: %s removed, %s inserted. The '
           'table''s triggers were held off, so nothing was logged, stamped or written elsewhere: '
           'this restore is recorded in recovery.restore_preimages, and anything derived from the '
           'table needs its own sync. Check any identity sequence before inserting again.',
           v_now_rows, v_snap.row_count, v_snap.taken_at, v_removed, v_inserted)::text;
end;
$function$;

revoke execute on function recovery.restore_table(text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function recovery.restore_table(text, text, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------- 2. who changed a decision

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

  -- WHO made THIS write: the person the request names, exactly as the employee and salary logs
  -- read it.
  begin
    v_actor := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-phoenix-actor-hr-id', '');
  exception when others then
    v_actor := null;
  end;
  -- The row's own decided_by is whoever decided LAST, not whoever is writing now. It stands in
  -- only when this write is what set it: an insert, or an update that moved decided_by or
  -- decided_at. A note edited by someone the request does not name is recorded with no actor,
  -- never under the decider's name.
  if v_actor is null
     and (tg_op = 'INSERT'
          or (tg_op = 'UPDATE'
              and ((o -> 'decided_by') is distinct from (n -> 'decided_by')
                   or (o -> 'decided_at') is distinct from (n -> 'decided_at')))) then
    v_actor := nullif(r ->> 'decided_by', '');
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
  'decision_changed, decision_deleted). An untouched Pending placeholder is not logged. The actor '
  'is the person the request names; the row''s decided_by only when this write set it.';

revoke execute on function public.phx_log_deduction_decision_change() from public, anon, authenticated;
grant execute on function public.phx_log_deduction_decision_change() to service_role;

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
    'cv_path', 'cv_file_name', 'photo_path',
    'exit_reason', 'bank_name'
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

commit;

-- Timestamp 20261114024807 was minted to sort after every migration already on main.

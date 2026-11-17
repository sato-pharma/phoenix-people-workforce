-- system_audit_alert_and_run_fixes
--
-- WHAT THIS CHANGES (three System Audit functions, replaced in place; one data correction):
--   1. public.system_audit_transition_status(uuid, text, text, text, text, timestamptz, jsonb, uuid)
--      a. refuses an occurrence that belongs to a different issue (errcode 22023);
--      b. clears system_audit_issues.alerted_status whenever the issue moves to any status other
--         than not_fixed.
--   2. public.system_audit_mark_alerted(uuid[]) counts the people it records as told over the
--      occurrences that are not triaged away (triage_override is null) - the same rows
--      system_audit_alert_candidates() counts.
--   3. public.system_audit_upsert_occurrences(text, uuid, jsonb, jsonb, text, jsonb) takes the
--      incoming pre_fix_build when the incoming last_event_at is later than the stored one.
--   4. Data: alerted_status set to null on every issue that is NOT not_fixed but still carries
--      alerted_status = 'not_fixed' (0 rows in production at 17 Nov 2026, 04:23 Cairo).
--   Every function stays SECURITY INVOKER with search_path = pg_catalog, public; none of the three
--   carries a work_mem setting. EXECUTE is re-asserted: revoked from public, anon and authenticated,
--   granted to service_role only.
-- WHY:
--   1b. The daily message tells a reopened issue once - while alerted_status is distinct from
--       not_fixed. alerted_status was never cleared, so an issue reopened, told, fixed and verified,
--       then reopened AGAIN still read "already told" and its second reopen was never said.
--   1a. A recurrence invalidates the issue's fix and is written into the status history by its
--       occurrence id; nothing checked that the occurrence was this issue's own.
--   2.  The candidates read counts people over non-triaged rows but the mark counted all rows, so a
--       triaged-away person could lift alerted_people to 2 and silence the "newly shared" message.
--   3.  The verifier now judges a recurrence by an occurrence's LAST event; a row it once set aside
--       as an older build kept that mark forever, hiding a later event from a newer build.
-- ROLLBACK: re-run the three function definitions from
--   supabase/migrations/20261023051848_system_audit_functions.sql (create or replace, same
--   signatures). The data correction (4) is not undone: it only lets the reopen message speak again
--   for issues that are no longer not_fixed, and matched 0 rows when written.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

-- --- 1. Status transitions ---------------------------------------------------------------------
create or replace function public.system_audit_transition_status(
  p_issue_id uuid,
  p_to text,
  p_actor text,
  p_reason text default null,
  p_fix_sha text default null,
  p_fix_live_at timestamptz default null,
  p_evidence jsonb default '{}'::jsonb,
  p_occurrence_id uuid default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_issue public.system_audit_issues%rowtype;
  v_is_verifier boolean := p_actor = 'system:verifier';
  v_is_seed boolean := p_actor like 'seed:%';
  v_live_at timestamptz;
  v_generation integer;
  v_fix_id uuid;
begin
  if p_to not in ('fixed_verified', 'not_fixed', 'investigating', 'fix_implemented', 'no_defect', 'unknown') then
    raise exception 'unknown status %', p_to using errcode = '22023';
  end if;
  if coalesce(btrim(p_actor), '') = '' then
    raise exception 'a status change needs an actor' using errcode = '22023';
  end if;

  select * into v_issue from public.system_audit_issues where id = p_issue_id for update;
  if not found then
    raise exception 'issue % not found', p_issue_id using errcode = 'P0002';
  end if;

  -- The occurrence a change is recorded against (the one that reopens a fix) must be one of THIS
  -- issue's: a foreign one would invalidate this issue's fix on another issue's evidence and leave a
  -- history row pointing at the wrong place. The sentence reaches the System Audit page verbatim.
  if p_occurrence_id is not null and not exists (
    select 1 from public.system_audit_occurrences o
     where o.id = p_occurrence_id and o.issue_id = p_issue_id
  ) then
    raise exception 'That occurrence is not one of this issue''s occurrences, so the change was not made.'
      using errcode = '22023';
  end if;

  -- Nobody asserts a fix by hand: FIXED — VERIFIED comes from the verifier's re-measurement, or
  -- from the reviewed historical seed carrying that re-measurement as evidence.
  if p_to = 'fixed_verified' and not (v_is_verifier or (v_is_seed and coalesce(p_evidence, '{}'::jsonb) <> '{}'::jsonb)) then
    raise exception 'FIXED — VERIFIED is set only by the verifier, with evidence' using errcode = '42501';
  end if;
  if p_to in ('no_defect', 'unknown') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required for %', p_to using errcode = '22023';
  end if;

  if p_to = 'fix_implemented' or (p_to = 'fixed_verified' and p_fix_sha is not null) then
    if p_fix_sha is null or p_fix_sha !~ '^[0-9a-f]{40}$' then
      raise exception 'a fix needs its full 40-character commit' using errcode = '22023';
    end if;
    -- Staging has no release gate (production only), so the table is looked up, never assumed.
    if to_regclass('public.release_gates') is not null then
      execute 'select g.recorded_at from public.release_gates g where g.sha = $1' into v_live_at using p_fix_sha;
    end if;
    if v_live_at is null then
      -- release_gates starts on 2026-10-19; an older fix's live time comes only from the reviewed
      -- seed, which carries the merge time as evidence.
      if (v_is_seed or v_is_verifier) and p_fix_live_at is not null then
        v_live_at := p_fix_live_at;
      else
        raise exception 'commit % is not a released build', p_fix_sha using errcode = '22023';
      end if;
    end if;
    select coalesce(max(f.generation), 0) + 1 into v_generation
    from public.system_audit_issue_fixes f where f.issue_id = p_issue_id;
    insert into public.system_audit_issue_fixes (issue_id, generation, fix_commit_sha, fix_live_at, created_by)
    values (p_issue_id, v_generation, p_fix_sha, v_live_at, p_actor)
    returning id into v_fix_id;
  end if;

  if p_to = 'fixed_verified' then
    update public.system_audit_issue_fixes f
       set verified_at = now(), verification = coalesce(p_evidence, '{}'::jsonb)
     where f.id = coalesce(v_fix_id, (
       select f2.id from public.system_audit_issue_fixes f2
        where f2.issue_id = p_issue_id and f2.invalidated_at is null
        order by f2.generation desc limit 1));
    if not found then
      raise exception 'FIXED — VERIFIED needs a fix to verify' using errcode = '22023';
    end if;
  end if;

  if p_to = 'not_fixed' and v_is_verifier and p_occurrence_id is not null then
    -- A recurrence after the fix went live reopens it.
    update public.system_audit_issue_fixes f
       set invalidated_at = now(), invalidated_by_occurrence = p_occurrence_id
     where f.issue_id = p_issue_id and f.invalidated_at is null;
  end if;

  update public.system_audit_issues
     set status = p_to,
         -- What the daily message last said about the status holds only while that status stands:
         -- once the issue leaves "not fixed", the next reopen is news again and must be told.
         alerted_status = case when p_to = 'not_fixed' then alerted_status else null end,
         updated_at = now()
   where id = p_issue_id;

  insert into public.system_audit_status_history (issue_id, occurrence_id, from_status, to_status, actor, reason, evidence)
  values (p_issue_id, p_occurrence_id, v_issue.status, p_to, p_actor, p_reason, coalesce(p_evidence, '{}'::jsonb));

  return jsonb_build_object('issueId', p_issue_id, 'from', v_issue.status, 'to', p_to, 'fixId', v_fix_id);
end;
$$;

-- --- 2. Marking what the daily message told ----------------------------------------------------
create or replace function public.system_audit_mark_alerted(p_issue_ids uuid[])
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  with people as (
    select o.issue_id, (count(distinct o.hr_key) filter (where o.hr_key is not null))::integer as people
    from public.system_audit_occurrences o
    where o.issue_id = any (p_issue_ids) and not o.is_test and o.triage_override is null
    group by o.issue_id
  )
  update public.system_audit_issues i
     set alerted_at = now(),
         alerted_people = coalesce(p.people, 0),
         alerted_status = i.status
    from (select unnest(p_issue_ids) as id) ids
    left join people p on p.issue_id = ids.id
   where i.id = ids.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- 3. Detector writes ------------------------------------------------------------------------
create or replace function public.system_audit_upsert_occurrences(
  p_detector text,
  p_run_id uuid,
  p_issues jsonb,
  p_rows jsonb,
  p_merge text default 'max',
  p_cursor jsonb default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer := 0;
  v_updated integer := 0;
  v_issues integer := 0;
begin
  if p_merge not in ('add', 'max') then
    raise exception 'unknown merge mode %', p_merge using errcode = '22023';
  end if;

  -- Issues: created on first sight. Status and a triaged root cause are never overwritten here —
  -- they change only through system_audit_transition_status.
  with incoming as (
    select *
    from jsonb_to_recordset(coalesce(p_issues, '[]'::jsonb)) as x(
      signature_key text, family text, error_code text, title text,
      root_cause_level text, root_cause text, root_cause_evidence jsonb,
      status text, first_seen_at timestamptz, last_seen_at timestamptz)
  ),
  upserted as (
    insert into public.system_audit_issues as i (
      signature_key, family, error_code, title, status, root_cause_level, root_cause,
      root_cause_evidence, first_seen_at, last_seen_at)
    select
      x.signature_key, x.family, x.error_code, x.title,
      coalesce(nullif(x.status, ''), 'investigating'),
      coalesce(nullif(x.root_cause_level, ''), 'unknown'),
      x.root_cause,
      coalesce(x.root_cause_evidence, '{}'::jsonb),
      x.first_seen_at, x.last_seen_at
    from incoming x
    on conflict (signature_key) do update set
      first_seen_at = least(i.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(i.last_seen_at, excluded.last_seen_at),
      root_cause_level = case when i.root_cause_level = 'unknown' then excluded.root_cause_level else i.root_cause_level end,
      root_cause = case when i.root_cause_level = 'unknown' and excluded.root_cause is not null then excluded.root_cause else i.root_cause end,
      root_cause_evidence = case when i.root_cause_level = 'unknown' and excluded.root_cause_evidence <> '{}'::jsonb then excluded.root_cause_evidence else i.root_cause_evidence end,
      updated_at = now()
    returning 1
  )
  select count(*) into v_issues from upserted;

  with incoming as (
    select *
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
      dedupe_key text, signature_key text, correlation_id uuid, is_root_symptom boolean,
      hr_key text, hr_id_display text, employee_name text, role_at_event text,
      module_label text, module_label_source text, shell text, route text,
      occurred_at timestamptz, occurred_at_kind text, affected_date date,
      user_message text, is_silent boolean, technical_message text, error_code text,
      related_table text, related_id text, attempt_count integer, page_loads integer,
      first_event_at timestamptz, last_event_at timestamptz, source_refs jsonb,
      release text, pre_fix_build boolean, evidence jsonb, is_test boolean)
  ),
  resolved as (
    select r.*, i.id as issue_id, i.family
    from incoming r
    join public.system_audit_issues i on i.signature_key = r.signature_key
  ),
  written as (
    insert into public.system_audit_occurrences as o (
      dedupe_key, issue_id, signature_key, family, correlation_id, is_root_symptom,
      hr_key, hr_id_display, employee_name, role_at_event, module_label, module_label_source,
      shell, route, occurred_at, occurred_at_kind, affected_date, user_message, is_silent,
      technical_message, error_code, related_table, related_id, attempt_count, page_loads,
      first_event_at, last_event_at, source_refs, release, pre_fix_build, evidence, is_test,
      detector_run_id)
    select
      r.dedupe_key, r.issue_id, r.signature_key, r.family, r.correlation_id, coalesce(r.is_root_symptom, true),
      r.hr_key, r.hr_id_display, r.employee_name, r.role_at_event, r.module_label, r.module_label_source,
      r.shell, r.route, r.occurred_at, r.occurred_at_kind, r.affected_date, r.user_message, coalesce(r.is_silent, false),
      left(r.technical_message, 1000), r.error_code, r.related_table, r.related_id,
      greatest(coalesce(r.attempt_count, 1), 1), greatest(coalesce(r.page_loads, 1), 1),
      coalesce(r.first_event_at, r.occurred_at), coalesce(r.last_event_at, r.occurred_at),
      coalesce(r.source_refs, '[]'::jsonb), r.release, coalesce(r.pre_fix_build, false),
      coalesce(r.evidence, '{}'::jsonb), coalesce(r.is_test, false), p_run_id
    from resolved r
    on conflict (dedupe_key) do update set
      attempt_count = case when p_merge = 'add' then o.attempt_count + excluded.attempt_count
                           else greatest(o.attempt_count, excluded.attempt_count) end,
      -- An extension of an open operation may bring NO new page load (a retry inside the same load):
      -- the column is clamped to 1 for the insert, so the true delta travels in
      -- evidence.newPageLoads and is what gets added.
      page_loads = case when p_merge = 'add' then o.page_loads + case
                          when (excluded.evidence ->> 'newPageLoads') ~ '^[0-9]{1,6}$'
                            then (excluded.evidence ->> 'newPageLoads')::integer
                          else excluded.page_loads end
                        else greatest(o.page_loads, excluded.page_loads) end,
      first_event_at = least(o.first_event_at, excluded.first_event_at),
      last_event_at = greatest(o.last_event_at, excluded.last_event_at),
      source_refs = case when p_merge = 'add' then
          coalesce((select jsonb_agg(e) from (
            select e from jsonb_array_elements(o.source_refs || excluded.source_refs) e limit 50) capped), '[]'::jsonb)
        else case when jsonb_array_length(excluded.source_refs) > 0 then excluded.source_refs else o.source_refs end end,
      technical_message = coalesce(excluded.technical_message, o.technical_message),
      evidence = case when excluded.evidence <> '{}'::jsonb then excluded.evidence else o.evidence end,
      release = coalesce(excluded.release, o.release),
      -- A row the verifier set aside as an older build is judged again once a LATER event lands on
      -- it: that event carries its own release, so the old build's mark no longer speaks for it.
      -- (Every SET expression reads the row as it was, so o.last_event_at is the stored value.)
      pre_fix_build = case when excluded.last_event_at > o.last_event_at then excluded.pre_fix_build
                           else o.pre_fix_build end,
      -- A detector that re-judges a day (the visit lifecycle) may mint a new correlation id when the
      -- day's lost visits change; the root row follows it, so its linked rows stay one operation.
      correlation_id = coalesce(excluded.correlation_id, o.correlation_id),
      detector_run_id = excluded.detector_run_id,
      updated_at = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
  from written;

  if p_cursor is not null then
    insert into public.system_audit_watermarks as w (detector, cursor, updated_at)
    values (p_detector, p_cursor, now())
    on conflict (detector) do update set cursor = excluded.cursor, updated_at = now();
  end if;

  return jsonb_build_object('issues', v_issues, 'inserted', v_inserted, 'updated', v_updated);
end;
$$;

-- --- 4. Data: a not-fixed mark left on an issue that is no longer not fixed --------------------
update public.system_audit_issues
   set alerted_status = null
 where status <> 'not_fixed'
   and alerted_status = 'not_fixed';

do $do$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.system_audit_upsert_occurrences(text, uuid, jsonb, jsonb, text, jsonb)',
    'public.system_audit_transition_status(uuid, text, text, text, text, timestamptz, jsonb, uuid)',
    'public.system_audit_mark_alerted(uuid[])'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end
$do$;

commit;

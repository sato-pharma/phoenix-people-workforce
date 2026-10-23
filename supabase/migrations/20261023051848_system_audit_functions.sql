-- system_audit_functions
--
-- WHAT THIS CHANGES:
--   Adds the seven functions the System Error & Data Integrity Audit reads and writes through.
--   All are SECURITY INVOKER and executable by service_role only:
--   1. system_audit_page(filters, sort, limit, offset, after)  the 11-column page and the export.
--      Returns ONE jsonb value, so PostgREST's 1,000-row cap never truncates it silently.
--      Columns 10 and 11 (operations per person, people per signature) are counted over the whole
--      PERIOD, never over the filtered rows — filtering to one person must not turn "shared" into
--      "only this employee".
--   2. system_audit_upsert_occurrences(detector, run, issues, rows, merge, cursor)  every detector
--      write, in one transaction with its watermark, so a re-run is a no-op.
--   3. system_audit_transition_status(...)  the only way an issue's status changes. A person may set
--      investigating / not fixed / no defect / unknown / fix implemented (the fix commit must be a
--      live release); only the verifier (or the reviewed historical seed, with evidence) sets
--      FIXED — VERIFIED.
--   4. system_audit_triage_occurrence(...)  marks one occurrence no-defect / unknown, with a reason.
--   5. system_audit_acquire_lease / system_audit_release_lease  so two sweeps never overlap.
--   6. system_audit_alert_candidates / system_audit_mark_alerted  what the one daily message
--      carries: issues that are new, newly shared, or reopened since it last went out.
--
-- WHY: see 20261023051847_system_audit_ledger.sql.
--
-- ROLLBACK:
--   drop function if exists public.system_audit_page(jsonb, text, integer, integer, jsonb),
--     public.system_audit_upsert_occurrences(text, uuid, jsonb, jsonb, text, jsonb),
--     public.system_audit_transition_status(uuid, text, text, text, text, timestamptz, jsonb, uuid),
--     public.system_audit_triage_occurrence(uuid, text, text, text),
--     public.system_audit_acquire_lease(text, text, integer),
--     public.system_audit_release_lease(text, text),
--     public.system_audit_alert_candidates(),
--     public.system_audit_mark_alerted(uuid[]);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes no existing application data.

begin;
set local lock_timeout = '5s';

-- ─── 1. The page and the export ───────────────────────────────────────────────────────────────
-- Built to stay inside 1.5 s at 100,000 rows without spilling to disk (measured on staging):
--   * the filtered set is carried NARROW (id, time, signature, person, sort key, status) and the wide
--     columns are read only for the rows actually returned;
--   * columns 10 and 11 are counted with hash aggregates over the period (no count(distinct), no
--     IS NOT DISTINCT FROM join, which cannot hash), and only for the signatures being shown;
--   * the page is a top-N sort with LIMIT/OFFSET, never a row_number() over the whole set;
--   * the export (p_after set) walks system_audit_occurrences_time_idx backwards and stops at the
--     batch size, and returns no total.
-- plan_cache_mode = force_custom_plan: every filter is a plpgsql variable, and a cached generic plan
-- could neither drop the unused filters nor match the partial indexes' "not is_test".
create or replace function public.system_audit_page(
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'occurred_desc',
  p_limit integer default 50,
  p_offset integer default 0,
  p_after jsonb default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
set work_mem = '32MB'
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date := nullif(v_filters ->> 'from', '')::date;
  v_to date := nullif(v_filters ->> 'to', '')::date;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_hr_keys text[];
  v_modules text[];
  v_statuses text[];
  v_levels text[];
  v_families text[];
  v_scope text := nullif(v_filters ->> 'scope', '');
  v_search text := nullif(btrim(coalesce(v_filters ->> 'search', '')), '');
  v_include_silent boolean := coalesce((v_filters ->> 'includeSilent')::boolean, true);
  v_include_test boolean := coalesce((v_filters ->> 'includeTest')::boolean, false);
  v_keyset boolean := p_after is not null;
  v_after_at timestamptz := nullif(p_after ->> 'occurredAt', '')::timestamptz;
  v_after_id uuid := nullif(p_after ->> 'id', '')::uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), case when p_after is not null then 5000 else 200 end));
  v_offset integer := case when p_after is not null then 0 else greatest(0, least(coalesce(p_offset, 0), 10000)) end;
  v_sort text := coalesce(nullif(p_sort, ''), 'occurred_desc');
  -- The export stops at the batch size while it scans, unless the only/shared filter needs the
  -- whole period's people counts first.
  v_stream_limit integer;
  v_result jsonb;
begin
  if v_sort not in ('occurred_desc', 'occurred_asc', 'employee', 'module', 'person_ops', 'people') then
    raise exception 'unknown sort %', v_sort using errcode = '22023';
  end if;
  if v_scope is not null and v_scope not in ('only', 'shared', 'system') then
    raise exception 'unknown scope %', v_scope using errcode = '22023';
  end if;
  if v_keyset then
    v_sort := 'occurred_desc';
  end if;
  v_stream_limit := case when v_keyset and v_scope is null then v_limit end;

  -- Cairo calendar days, turned into UTC bounds once (never a bare current_date).
  v_from_ts := case when v_from is null then null else (v_from::timestamp at time zone 'Africa/Cairo') end;
  v_to_ts := case when v_to is null then null else ((v_to + 1)::timestamp at time zone 'Africa/Cairo') end;

  select array_agg(x) into v_hr_keys from jsonb_array_elements_text(coalesce(v_filters -> 'hrKeys', '[]'::jsonb)) x;
  select array_agg(x) into v_modules from jsonb_array_elements_text(coalesce(v_filters -> 'modules', '[]'::jsonb)) x;
  select array_agg(x) into v_statuses from jsonb_array_elements_text(coalesce(v_filters -> 'statuses', '[]'::jsonb)) x;
  select array_agg(x) into v_levels from jsonb_array_elements_text(coalesce(v_filters -> 'rootCauseLevels', '[]'::jsonb)) x;
  select array_agg(x) into v_families from jsonb_array_elements_text(coalesce(v_filters -> 'families', '[]'::jsonb)) x;
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with iss as materialized (
    select
      i.id, i.title, i.root_cause_level, i.root_cause, i.status,
      exists (
        select 1 from public.system_audit_issue_fixes f
        where f.issue_id = i.id and f.invalidated_at is null
      ) as has_fix
    from public.system_audit_issues i
  ),
  filtered as materialized (
    select x.id, x.occurred_at, x.signature_key, x.hr_key, x.sort_text, x.display_status
    from (
      select
        o.id, o.occurred_at, o.signature_key, o.hr_key,
        case v_sort
          when 'employee' then coalesce(o.employee_name, o.hr_id_display, '~')
          when 'module' then o.module_label
        end as sort_text,
        case
          when o.triage_override is not null then o.triage_override
          -- The fix that FOLLOWED this occurrence decides its status: a row that happened before a
          -- verified fix is fixed, a row after every fix shows the issue's live status. Only issues
          -- that have a fix pay for the lookup.
          when i.has_fix then coalesce((
            select case when f.verified_at is not null then 'fixed_verified' else 'fix_implemented' end
            from public.system_audit_issue_fixes f
            where f.issue_id = o.issue_id
              and f.invalidated_at is null
              and f.fix_live_at > o.occurred_at
            order by f.fix_live_at asc
            limit 1
          ), i.status)
          else i.status
        end as display_status
      from public.system_audit_occurrences o
      join iss i on i.id = o.issue_id
      where (v_from_ts is null or o.occurred_at >= v_from_ts)
        and (v_to_ts is null or o.occurred_at < v_to_ts)
        and (v_include_test or not o.is_test)
        and (v_after_at is null or (o.occurred_at, o.id) < (v_after_at, v_after_id))
        and (v_hr_keys is null or o.hr_key = any (v_hr_keys))
        and (v_modules is null or o.module_label = any (v_modules))
        and (v_levels is null or i.root_cause_level = any (v_levels))
        and (v_families is null or o.family = any (v_families))
        and (v_include_silent or not o.is_silent)
        and (
          v_search is null
          or i.title ilike v_search
          or o.technical_message ilike v_search
          or o.user_message ilike v_search
          or o.employee_name ilike v_search
          or o.hr_id_display ilike v_search
          or o.error_code ilike v_search
          or o.module_label ilike v_search
        )
    ) x
    where v_statuses is null or x.display_status = any (v_statuses)
    order by case when v_stream_limit is not null then x.occurred_at end desc,
             case when v_stream_limit is not null then x.id end desc
    limit v_stream_limit
  ),
  ops as (
    -- One row per signature x person x operation. coalesce(hr_key, '') keeps every join hashable;
    -- '' is never a real HR id key.
    select o.signature_key, coalesce(o.hr_key, '') as hr_k, o.correlation_id, count(*) as n
    from public.system_audit_occurrences o
    where (v_from_ts is null or o.occurred_at >= v_from_ts)
      and (v_to_ts is null or o.occurred_at < v_to_ts)
      and (v_include_test or not o.is_test)
      and o.signature_key in (select f.signature_key from filtered f)
    group by o.signature_key, coalesce(o.hr_key, ''), o.correlation_id
  ),
  per_person as (
    -- Column 10: operations per person for this signature, over the PERIOD. A correlation id
    -- (one lost visit seen in several modules) counts once.
    select op.signature_key, op.hr_k,
      sum(case when op.correlation_id is null then op.n else 1 end)::integer as person_ops
    from ops op
    group by op.signature_key, op.hr_k
  ),
  per_sig as (
    -- Column 11: distinct people for this signature, over the PERIOD. Rows with no person are
    -- system rows and are never counted as an employee.
    select pp.signature_key, (count(*) filter (where pp.hr_k <> ''))::integer as people
    from per_person pp
    group by pp.signature_key
  ),
  scoped as materialized (
    select f.id, f.occurred_at, f.sort_text, f.display_status, pp.person_ops, ps.people
    from filtered f
    join per_person pp on pp.signature_key = f.signature_key and pp.hr_k = coalesce(f.hr_key, '')
    join per_sig ps on ps.signature_key = f.signature_key
    where v_scope is null
      or (v_scope = 'only' and f.hr_key is not null and ps.people = 1)
      or (v_scope = 'shared' and f.hr_key is not null and ps.people >= 2)
      or (v_scope = 'system' and f.hr_key is null)
  ),
  picked as (
    select q.*, row_number() over (
      order by q.k_asc_ts asc, q.k_text asc, q.k_desc_int desc, q.occurred_at desc, q.id desc
    ) as ord
    from (
      select
        s.*,
        case when v_sort = 'occurred_asc' then s.occurred_at end as k_asc_ts,
        case when v_sort in ('employee', 'module') then s.sort_text end as k_text,
        case v_sort when 'person_ops' then s.person_ops when 'people' then s.people end as k_desc_int
      from scoped s
      order by k_asc_ts asc, k_text asc, k_desc_int desc, s.occurred_at desc, s.id desc
      limit v_limit offset v_offset
    ) q
  ),
  shaped as (
    select
      p.ord,
      p.occurred_at,
      p.id,
      jsonb_build_object(
        'id', o.id,
        'issueId', o.issue_id,
        'signatureKey', o.signature_key,
        'family', o.family,
        'hrKey', o.hr_key,
        'hrId', o.hr_id_display,
        'employeeName', o.employee_name,
        'roleAtEvent', o.role_at_event,
        'moduleLabel', o.module_label,
        'moduleLabelSource', o.module_label_source,
        'shell', o.shell,
        'route', o.route,
        'occurredAt', o.occurred_at,
        'occurredAtKind', o.occurred_at_kind,
        'affectedDate', o.affected_date,
        'userMessage', o.user_message,
        'isSilent', o.is_silent,
        'technicalMessage', o.technical_message,
        'errorCode', o.error_code,
        'title', i.title,
        'rootCauseLevel', i.root_cause_level,
        'rootCause', i.root_cause,
        'status', p.display_status,
        'issueStatus', i.status,
        'personOps', p.person_ops,
        'people', p.people,
        'attemptCount', o.attempt_count,
        'pageLoads', o.page_loads,
        'firstEventAt', o.first_event_at,
        'lastEventAt', o.last_event_at,
        'correlationId', o.correlation_id,
        'isRootSymptom', o.is_root_symptom,
        'relatedTable', o.related_table,
        'relatedId', o.related_id,
        'release', o.release,
        'preFixBuild', o.pre_fix_build,
        'triageOverride', o.triage_override,
        'triageReason', o.triage_reason,
        'isTest', o.is_test
      ) as row_json
    from picked p
    join public.system_audit_occurrences o on o.id = p.id
    join iss i on i.id = o.issue_id
  )
  select jsonb_build_object(
    -- The export is not counted: it walks to the end and the caller counts what it wrote.
    'total', case when v_keyset then null else (select count(*)::integer from scoped) end,
    'limit', v_limit,
    'offset', v_offset,
    'rows', coalesce((select jsonb_agg(sh.row_json order by sh.ord) from shaped sh), '[]'::jsonb),
    'next', (
      select case when v_keyset and count(*) = v_limit then
        jsonb_build_object('occurredAt', (array_agg(s3.occurred_at order by s3.ord desc))[1],
                           'id', (array_agg(s3.id order by s3.ord desc))[1])
      end
      from shaped s3
    )
  )
  into v_result;

  return v_result;
end;
$$;

-- ─── 2. Detector writes ───────────────────────────────────────────────────────────────────────
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

-- ─── 3. Status transitions ────────────────────────────────────────────────────────────────────
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
     set status = p_to, updated_at = now()
   where id = p_issue_id;

  insert into public.system_audit_status_history (issue_id, occurrence_id, from_status, to_status, actor, reason, evidence)
  values (p_issue_id, p_occurrence_id, v_issue.status, p_to, p_actor, p_reason, coalesce(p_evidence, '{}'::jsonb));

  return jsonb_build_object('issueId', p_issue_id, 'from', v_issue.status, 'to', p_to, 'fixId', v_fix_id);
end;
$$;

create or replace function public.system_audit_triage_occurrence(
  p_occurrence_id uuid,
  p_override text,
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_occurrence public.system_audit_occurrences%rowtype;
begin
  if p_override is not null and p_override not in ('no_defect', 'unknown') then
    raise exception 'unknown triage %', p_override using errcode = '22023';
  end if;
  if p_override is not null and coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if coalesce(btrim(p_actor), '') = '' then
    raise exception 'a triage needs an actor' using errcode = '22023';
  end if;

  select * into v_occurrence from public.system_audit_occurrences where id = p_occurrence_id for update;
  if not found then
    raise exception 'occurrence % not found', p_occurrence_id using errcode = 'P0002';
  end if;

  update public.system_audit_occurrences
     set triage_override = p_override, triage_reason = case when p_override is null then null else p_reason end, updated_at = now()
   where id = p_occurrence_id;

  insert into public.system_audit_status_history (issue_id, occurrence_id, from_status, to_status, actor, reason)
  values (v_occurrence.issue_id, p_occurrence_id, coalesce(v_occurrence.triage_override, 'occurrence'),
          coalesce(p_override, 'occurrence'), p_actor, p_reason);

  return jsonb_build_object('occurrenceId', p_occurrence_id, 'triage', p_override);
end;
$$;

-- ─── 4. The sweep lease ───────────────────────────────────────────────────────────────────────
create or replace function public.system_audit_acquire_lease(p_detector text, p_holder text, p_seconds integer)
returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_ok boolean;
begin
  insert into public.system_audit_watermarks as w (detector, lease_holder, lease_until, updated_at)
  values (p_detector, p_holder, now() + make_interval(secs => greatest(p_seconds, 1)), now())
  on conflict (detector) do update
    set lease_holder = excluded.lease_holder, lease_until = excluded.lease_until, updated_at = now()
    where w.lease_until is null or w.lease_until < now() or w.lease_holder = excluded.lease_holder
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.system_audit_release_lease(p_detector text, p_holder text)
returns void
language sql
set search_path = pg_catalog, public
as $$
  update public.system_audit_watermarks
     set lease_holder = null, lease_until = null, updated_at = now()
   where detector = p_detector and lease_holder = p_holder;
$$;

-- ─── 5. The one daily message ─────────────────────────────────────────────────────────────────
create or replace function public.system_audit_alert_candidates()
returns jsonb
language sql
stable
set search_path = pg_catalog, public
set work_mem = '32MB'
as $$
  with live as (
    select
      o.issue_id,
      (count(distinct o.hr_key) filter (where o.hr_key is not null))::integer as people,
      count(distinct coalesce(o.correlation_id, o.id))::integer as operations,
      max(o.occurred_at) as last_occurred_at
    from public.system_audit_occurrences o
    where not o.is_test and o.triage_override is null
    group by o.issue_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'issueId', i.id,
      'title', i.title,
      'family', i.family,
      'status', i.status,
      'people', l.people,
      'operations', l.operations,
      'lastOccurredAt', l.last_occurred_at,
      'reason', case
        when i.alerted_at is null then 'new'
        when i.status = 'not_fixed' and i.alerted_status is distinct from 'not_fixed' then 'reopened'
        else 'newly_shared'
      end
    ) order by l.people desc, l.last_occurred_at desc), '[]'::jsonb)
  from public.system_audit_issues i
  join live l on l.issue_id = i.id
  where i.status not in ('no_defect')
    and (
      i.alerted_at is null
      or (l.people >= 2 and i.alerted_people < 2)
      or (i.status = 'not_fixed' and i.alerted_status is distinct from 'not_fixed')
    );
$$;

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
    where o.issue_id = any (p_issue_ids) and not o.is_test
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

do $do$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.system_audit_page(jsonb, text, integer, integer, jsonb)',
    'public.system_audit_upsert_occurrences(text, uuid, jsonb, jsonb, text, jsonb)',
    'public.system_audit_transition_status(uuid, text, text, text, text, timestamptz, jsonb, uuid)',
    'public.system_audit_triage_occurrence(uuid, text, text, text)',
    'public.system_audit_acquire_lease(text, text, integer)',
    'public.system_audit_release_lease(text, text)',
    'public.system_audit_alert_candidates()',
    'public.system_audit_mark_alerted(uuid[])'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end
$do$;

commit;

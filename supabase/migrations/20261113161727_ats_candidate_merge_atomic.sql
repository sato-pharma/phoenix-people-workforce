-- ats_candidate_merge_atomic
--
-- WHAT THIS CHANGES: adds public.phx_merge_ats_candidates — every database write of a candidate
--   merge (mergeCandidates, src/lib/recruitment/candidate-merge-service.ts) in ONE function, so ONE
--   transaction: the deduped moves, the plain reassigns, the append-only copies, the WhatsApp
--   session relink, the delete of the duplicate row and the survivor's borrowed fields. No table,
--   column or row is changed by this file; only a function is created.
-- WHY: the merge used to be ~20 separate PostgREST calls with no transaction around them, so a
--   failure part-way (a 23505 raced in, a network drop, a check constraint on a copied comment)
--   left a HALF merge — some child rows on the survivor, the rest on a duplicate that still
--   existed. Two of twenty-three production merges stopped half-way on 2026-09-04. Inside one
--   function a failure anywhere rolls the whole merge back, and the duplicate stays whole.
--   Both candidate rows are locked FOR UPDATE, lowest id first, so two merges of the same pair
--   (or of A→B and B→A) queue instead of deadlocking, and the second one finds its duplicate gone
--   and refuses cleanly.
--   TypeScript still owns the gate, the reads, mergeBlockReason, WHAT to borrow (handed in as
--   p_borrow, whitelisted here), the provenance wording of a copied row (p_*_provenance), the
--   summary text, the best-effort merge history line and the Drive re-file afterwards.
-- ROLLBACK: drop function if exists public.phx_merge_ats_candidates(uuid, uuid, jsonb, text, text);
--   — and revert candidate-merge-service.ts to the step-by-step writes in the same change, or
--   every merge answers PGRST202.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_merge_ats_candidates(
  p_survivor_id uuid,
  p_duplicate_id uuid,
  p_borrow jsonb,
  p_status_event_provenance text,
  p_comment_provenance text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  -- The ONLY columns a merge may write onto the survivor: mergeableFields (candidate-merge.ts),
  -- the three _norm twins borrowedPayload adds, and screening_extra_answers. `status`, `notes`,
  -- `source` and the rest are deliberately absent — a borrowed status would undo a decision.
  v_allowed constant text[] := array[
    'national_id', 'email', 'phone', 'whatsapp', 'linkedin_url', 'nationality', 'date_of_birth',
    'place_of_birth', 'gender', 'marital_status', 'military_status', 'address', 'governorate',
    'current_job_title', 'applied_for_job_title', 'applied_for_evidence', 'professional_summary',
    'current_employer', 'current_role_responsibilities', 'years_experience', 'expected_salary',
    'declared_expected_salary', 'declared_background', 'declared_experience', 'notice_period',
    'cv_reference_name', 'cv_external_url', 'faculty', 'university', 'degree', 'graduation_year',
    'grade', 'medical_rep_employer', 'medical_rep_experience_from', 'medical_rep_experience_to',
    'offer_id',
    'email_norm', 'phone_norm', 'national_id_norm',
    'screening_extra_answers'
  ];
  -- Exactly the characters JavaScript's String.prototype.trim() removes (WhiteSpace + LineTerminator),
  -- so a copied note is trimmed the way describeCopiedHistoryLine trimmed it.
  v_ws constant text :=
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
    || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279);
  v_first uuid;
  v_second uuid;
  v_uuid_ids uuid[];
  v_big_ids bigint[];
  v_text_ids text[];
  v_moved integer;
  v_count integer;
  v_deduped jsonb := '{}'::jsonb;
  v_reassigned jsonb := '{}'::jsonb;
  v_copied jsonb := '{}'::jsonb;
  v_relinked jsonb := '{}'::jsonb;
  v_bad text[];
  v_set text;
  v_candidate jsonb := null;
begin
  if p_survivor_id is null or p_duplicate_id is null then
    raise exception 'Both the candidate to keep and the duplicate are required.' using errcode = '22023';
  end if;
  if p_survivor_id = p_duplicate_id then
    raise exception 'A candidate cannot be merged into itself.' using errcode = '22023';
  end if;
  if coalesce(p_status_event_provenance, '') = '' or coalesce(p_comment_provenance, '') = '' then
    raise exception 'phx_merge_ats_candidates: both provenance lines are required' using errcode = '22023';
  end if;
  if p_borrow is not null and jsonb_typeof(p_borrow) <> 'object' then
    raise exception 'phx_merge_ats_candidates: p_borrow must be a jsonb object' using errcode = '22023';
  end if;
  select array_agg(k order by k) into v_bad
    from jsonb_object_keys(coalesce(p_borrow, '{}'::jsonb)) k
   where k <> all (v_allowed);
  if v_bad is not null then
    raise exception 'phx_merge_ats_candidates: these columns may not be written by a merge: %', v_bad
      using errcode = '22023';
  end if;

  -- ── THE LOCK — both rows, lowest id first, so two merges touching the same pair queue rather
  -- than deadlock. A row that is gone by now (a concurrent merge already deleted it) refuses the
  -- whole merge before anything is written.
  v_first := least(p_survivor_id, p_duplicate_id);
  v_second := greatest(p_survivor_id, p_duplicate_id);
  perform 1 from public.ats_candidates where id = v_first for update;
  if not found then
    raise exception 'Candidate not found.' using errcode = 'P0002';
  end if;
  perform 1 from public.ats_candidates where id = v_second for update;
  if not found then
    raise exception 'Candidate not found.' using errcode = 'P0002';
  end if;

  -- ── STEP 2 — the five tables UNIQUE on (candidate_id, key). A duplicate row whose key the
  -- survivor already holds is BLOCKED (the survivor's own row wins); every other row moves. A NULL
  -- or empty key never blocks. Mirrors dedupedChildTables / splitRowsByExistingKey exactly.

  -- ats_candidate_manager_sends — unique (candidate_id, manager_hr_id); FK cascades the blocked rows.
  select coalesce(array_agg(d.id), '{}') into v_uuid_ids
    from public.ats_candidate_manager_sends d
   where d.candidate_id = p_duplicate_id
     and coalesce(d.manager_hr_id::text, '') <> ''
     and exists (
       select 1 from public.ats_candidate_manager_sends s
        where s.candidate_id = p_survivor_id and s.manager_hr_id = d.manager_hr_id
     );
  update public.ats_candidate_manager_sends
     set candidate_id = p_survivor_id
   where candidate_id = p_duplicate_id and id <> all (v_uuid_ids);
  get diagnostics v_moved = row_count;
  v_deduped := v_deduped || jsonb_build_object('ats_candidate_manager_sends',
    jsonb_build_object('moved', v_moved, 'blocked', cardinality(v_uuid_ids)));

  -- ats_candidate_manager_folders — unique (candidate_id, manager_hr_id_norm); NO foreign key, so
  -- the blocked rows are deleted here or they outlive the duplicate as orphans.
  select coalesce(array_agg(d.id), '{}') into v_big_ids
    from public.ats_candidate_manager_folders d
   where d.candidate_id = p_duplicate_id
     and coalesce(d.manager_hr_id_norm::text, '') <> ''
     and exists (
       select 1 from public.ats_candidate_manager_folders s
        where s.candidate_id = p_survivor_id and s.manager_hr_id_norm = d.manager_hr_id_norm
     );
  update public.ats_candidate_manager_folders
     set candidate_id = p_survivor_id
   where candidate_id = p_duplicate_id and id <> all (v_big_ids);
  get diagnostics v_moved = row_count;
  delete from public.ats_candidate_manager_folders
   where candidate_id = p_duplicate_id and id = any (v_big_ids);
  v_deduped := v_deduped || jsonb_build_object('ats_candidate_manager_folders',
    jsonb_build_object('moved', v_moved, 'blocked', cardinality(v_big_ids)));

  -- ats_candidate_district_returns — PARTIAL unique (manager_hr_id, candidate_id) WHERE status =
  -- 'open': only an open row on BOTH sides can collide; a resolved return always travels.
  select coalesce(array_agg(d.id), '{}') into v_uuid_ids
    from public.ats_candidate_district_returns d
   where d.candidate_id = p_duplicate_id
     and coalesce(d.status::text, '') = 'open'
     and coalesce(d.manager_hr_id::text, '') <> ''
     and exists (
       select 1 from public.ats_candidate_district_returns s
        where s.candidate_id = p_survivor_id
          and coalesce(s.status::text, '') = 'open'
          and s.manager_hr_id = d.manager_hr_id
     );
  update public.ats_candidate_district_returns
     set candidate_id = p_survivor_id
   where candidate_id = p_duplicate_id and id <> all (v_uuid_ids);
  get diagnostics v_moved = row_count;
  v_deduped := v_deduped || jsonb_build_object('ats_candidate_district_returns',
    jsonb_build_object('moved', v_moved, 'blocked', cardinality(v_uuid_ids)));

  -- ats_candidate_views — primary key (candidate_id, viewer_hr_id), NO id column: its rows are
  -- named by viewer_hr_id. FK cascades the blocked rows.
  select coalesce(array_agg(d.viewer_hr_id), '{}') into v_text_ids
    from public.ats_candidate_views d
   where d.candidate_id = p_duplicate_id
     and coalesce(d.viewer_hr_id::text, '') <> ''
     and exists (
       select 1 from public.ats_candidate_views s
        where s.candidate_id = p_survivor_id and s.viewer_hr_id = d.viewer_hr_id
     );
  update public.ats_candidate_views
     set candidate_id = p_survivor_id
   where candidate_id = p_duplicate_id and viewer_hr_id <> all (v_text_ids);
  get diagnostics v_moved = row_count;
  v_deduped := v_deduped || jsonb_build_object('ats_candidate_views',
    jsonb_build_object('moved', v_moved, 'blocked', cardinality(v_text_ids)));

  -- ats_cv_folder_items — unique (folder_id, candidate_id); NO foreign key on candidate_id, so the
  -- blocked rows are deleted here.
  select coalesce(array_agg(d.id), '{}') into v_big_ids
    from public.ats_cv_folder_items d
   where d.candidate_id = p_duplicate_id
     and coalesce(d.folder_id::text, '') <> ''
     and exists (
       select 1 from public.ats_cv_folder_items s
        where s.candidate_id = p_survivor_id and s.folder_id = d.folder_id
     );
  update public.ats_cv_folder_items
     set candidate_id = p_survivor_id
   where candidate_id = p_duplicate_id and id <> all (v_big_ids);
  get diagnostics v_moved = row_count;
  delete from public.ats_cv_folder_items
   where candidate_id = p_duplicate_id and id = any (v_big_ids);
  v_deduped := v_deduped || jsonb_build_object('ats_cv_folder_items',
    jsonb_build_object('moved', v_moved, 'blocked', cardinality(v_big_ids)));

  -- ── STEP 3 — the plain child tables, re-pointed whole. Applications first: the only one with a
  -- unique index that can still refuse (recruitment_applications_active_uidx).
  update public.ats_applications set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_reassigned := v_reassigned || jsonb_build_object('ats_applications', v_count);

  update public.ats_interview_bookings set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_reassigned := v_reassigned || jsonb_build_object('ats_interview_bookings', v_count);

  update public.ats_files set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_reassigned := v_reassigned || jsonb_build_object('ats_files', v_count);

  update public.ats_candidate_cv_extractions set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_reassigned := v_reassigned || jsonb_build_object('ats_candidate_cv_extractions', v_count);

  update public.ats_cv_intake_events set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_reassigned := v_reassigned || jsonb_build_object('ats_cv_intake_events', v_count);

  -- ── STEP 4 — the two append-only tables, COPIED (their triggers refuse an UPDATE). Every column
  -- carried verbatim, oldest first, and the note column gains the provenance line. Status-event
  -- originals stay (the trigger refuses DELETE too); comment originals — exactly the rows copied —
  -- are deleted, since nothing else would ever remove them.
  with src as (
    select e.id, e.actor_hr_id, e.created_at, e.from_status, e.note, e.to_status
      from public.ats_candidate_status_events e
     where e.candidate_id = p_duplicate_id
  ), ins as (
    insert into public.ats_candidate_status_events
      (candidate_id, actor_hr_id, created_at, from_status, note, to_status)
    select p_survivor_id, src.actor_hr_id, src.created_at, src.from_status,
           case when btrim(coalesce(src.note, ''), v_ws) <> ''
                then btrim(src.note, v_ws) || ' ' || p_status_event_provenance
                else p_status_event_provenance end,
           src.to_status
      from src
     order by src.created_at, src.id
    returning 1
  )
  select count(*) into v_count from ins;
  v_copied := v_copied || jsonb_build_object('ats_candidate_status_events', v_count);

  with src as (
    select c.id, c.author_hr_id, c.author_job_title, c.author_name, c.body, c.created_at
      from public.ats_candidate_comments c
     where c.candidate_id = p_duplicate_id
  ), ins as (
    insert into public.ats_candidate_comments
      (candidate_id, author_hr_id, author_job_title, author_name, body, created_at)
    select p_survivor_id, src.author_hr_id, src.author_job_title, src.author_name,
           case when btrim(coalesce(src.body, ''), v_ws) <> ''
                then btrim(src.body, v_ws) || ' ' || p_comment_provenance
                else p_comment_provenance end,
           src.created_at
      from src
     order by src.created_at, src.id
    returning 1
  ), del as (
    delete from public.ats_candidate_comments c
     where c.id in (select src.id from src)
    returning 1
  )
  select count(*) into v_count from ins;
  v_copied := v_copied || jsonb_build_object('ats_candidate_comments', v_count);

  -- ── STEP 5 — the record that links by a column of its own naming.
  update public.ats_whatsapp_classification_sessions
     set applied_candidate_id = p_survivor_id
   where applied_candidate_id = p_duplicate_id;
  get diagnostics v_count = row_count;
  v_relinked := v_relinked || jsonb_build_object('ats_whatsapp_classification_sessions', v_count);

  -- ── STEP 6 — the duplicate itself. Its email and national ID are freed here, before step 7
  -- writes them onto the survivor (both carry a partial UNIQUE index).
  delete from public.ats_candidates where id = p_duplicate_id;

  -- ── STEP 7 — the survivor's blanks, from the whitelisted columns TypeScript chose.
  if p_borrow is not null and p_borrow <> '{}'::jsonb then
    select string_agg(format('%I = r.%I', k, k), ', ' order by k) into v_set
      from jsonb_object_keys(p_borrow) k;
    execute format(
      'update public.ats_candidates c set %s, updated_at = now() '
      || 'from jsonb_populate_record(null::public.ats_candidates, $1) r '
      || 'where c.id = $2 returning to_jsonb(c)',
      v_set
    ) into v_candidate using p_borrow, p_survivor_id;
  end if;

  return jsonb_build_object(
    'deduped', v_deduped,
    'reassigned', v_reassigned,
    'copied', v_copied,
    'relinked', v_relinked,
    'candidate', v_candidate
  );
end;
$function$;

comment on function public.phx_merge_ats_candidates(uuid, uuid, jsonb, text, text) is
  'Recruitment: every database write of a candidate merge in one transaction (candidate-merge-service.ts mergeCandidates). Locks both candidate rows FOR UPDATE lowest id first; refuses if either is gone. Returns per-table moved/blocked/copied counts and, when p_borrow wrote anything, the survivor row.';

revoke execute on function public.phx_merge_ats_candidates(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.phx_merge_ats_candidates(uuid, uuid, jsonb, text, text) to service_role;

commit;

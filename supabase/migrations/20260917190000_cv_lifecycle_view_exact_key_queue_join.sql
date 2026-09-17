-- The CV-lifecycle view was costing a second per read, and it is read ~860 times a day.
--
-- MEASURED ON PRODUCTION 2026-09-17 (pg_stat_statements since 2026-09-09 00:59 Cairo): the one
-- statement that reads `ats_v_cv_lifecycle` — the owner's CV Lifecycle Google Sheet, which pulls
-- three 500-row pages every five minutes — was 11.5% of ALL database execution time: 7,296 calls,
-- mean 1,007 ms, max 5,786 ms. EXPLAIN (ANALYZE, BUFFERS) on the real page shapes put page 1 at
-- 1,484 ms and page 3 (OFFSET 1000) at 1,203 ms, against 1,429 CV files.
--
-- TWO CAUSES, AND THIS MIGRATION REMOVES BOTH WITHOUT CHANGING A SINGLE ROW.
--
-- 1. THE QUEUE JOIN WAS NOT AN EQUI-JOIN. It read
--        on q.channel = ev.channel and ((whatsapp leg) OR (email leg))
--    and an OR across two different key shapes cannot be hashed, so Postgres joined on `channel`
--    alone and tested the OR on every pair: "Rows Removed by Join Filter: 1,587,790", ~920 ms of
--    the 1,484. Both legs are now folded into ONE key pair per side —
--        whatsapp  (provider_message_id, '')
--        email     (mailbox, uid)            — split out of the queue's composite id, as before
--        any other channel → NULL, which matches nothing, exactly as the OR matched nothing
--    — so the join is `channel = channel and match_a = match_a and match_b = match_b`, which hashes
--    or merges. Row for row this is the same predicate: for a WhatsApp event the email leg of the
--    OR was already false, for an email event the WhatsApp leg was, and a NULL key fails `=` the
--    same way a false leg failed the OR. Multiplicity is unchanged too — a key that matched two
--    queue rows before matches the same two now.
--
-- 2. THE VIEW WAS WRITTEN WITH `WITH`, AND A VIEW THAT CARRIES ITS OWN CTEs IS NEVER FLATTENED INTO
--    THE QUERY THAT READS IT. That matters here because five columns call the CV-text flatteners
--    (`ats_cv_names_text` ×3, `ats_cv_education_text`, `ats_cv_work_text`). They are SQL functions
--    built on `string_agg`, so Postgres cannot inline them, and each call costs ~40 µs of executor
--    start-up. Inside an unflattened view they ran for EVERY file on EVERY page — 1,429 rows × 5
--    calls, three times per refresh — before the outer ORDER BY … LIMIT ever saw a row. With the
--    CTEs moved into FROM-clause subqueries the view flattens, and the planner defers those five
--    columns until after the sort (the `Result` node above `Sort` in the plan), so they run only
--    for the rows the page actually needs.
--
--    The functions themselves are NOT touched: `ats_candidate_cv_search_text` calls two of them, and an
--    inline copy of their bodies here was measured at only ~30% cheaper — not worth a second copy
--    of the formatting rules that could drift from the first.
--
-- MEASURED ON PRODUCTION, SAME DATA, READ-ONLY (the new body run as a subquery, which is exactly
-- how Postgres expands a view): page 1 1,484 → 162 ms, page 3 1,203 → 422 ms.
--
-- UNCHANGED, AND CHECKED BELOW RATHER THAN PROMISED:
--   * every column, in the same order, with the same type (`create or replace view` refuses a
--     retype or reorder, so a slip here fails the migration rather than the sheet)
--   * every row and every value — the whole view is fingerprinted before the replace and again
--     after, and the migration raises (rolling itself back) if the two differ
--   * `security_invoker = on`, and SELECT for service_role only

begin;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 1. Fingerprint the view as it is now.
--
-- One md5 over every row's full JSON, in the feed's own total order. A CV that arrives in the few
-- seconds between this statement and the check below would change the count and fail the migration
-- — a false alarm that rolls back cleanly and passes on a re-run, which is the right way round for a
-- check whose whole job is to refuse a changed report.
-- ─────────────────────────────────────────────────────────────────────────────────

create temp table cv_lifecycle_fingerprint_before on commit drop as
select
  count(*) as row_count,
  md5(coalesce(string_agg(to_jsonb(v)::text, E'\n' order by v.saved_in_phoenix_at desc, v.file_id desc), '')) as checksum
from public.ats_v_cv_lifecycle v;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 2. The view, flattened and equi-joined.
-- ─────────────────────────────────────────────────────────────────────────────────

create or replace view public.ats_v_cv_lifecycle
with (security_invoker = on)
as
select
  f.id as file_id,
  f.candidate_id,
  c.full_name as candidate_name,
  coalesce(nullif(c.whatsapp, ''), c.phone) as candidate_phone,
  c.status as candidate_status,
  c.applied_for_job_title,
  coalesce(ev.channel, 'upload') as channel,
  ev.source_channel_code,
  ev.sender_display_name,
  ev.sender_identifier,
  ev.mailbox_label,
  ev.provider_message_id,
  ev.outcome as intake_outcome,
  f.file_name,
  f.mime_type,
  f.size_bytes,
  q.created_at as arrived_at,
  q.claimed_at as picked_up_at,
  q.finished_at as intake_finished_at,
  q.status as queue_status,
  q.attempts as queue_attempts,
  q.last_error as queue_last_error,
  ev.intake_event_at,
  coalesce(q.created_at, ev.intake_event_at, f.created_at) as reached_phoenix_at,
  case
    when q.created_at is not null then 'queued'
    when ev.intake_event_at is not null then 'processed'
    else 'saved'
  end as timing_source,
  f.created_at as saved_in_phoenix_at,
  f.drive_mirror_at as saved_in_drive_at,
  f.drive_mirror_path as drive_folder,
  f.drive_mirror_file_id as drive_file_id,
  f.drive_mirror_error as drive_error,
  c.preferences_declared_at,
  c.folder_filed_at,
  c.folder_kind,
  c.folder_key,
  c.preferred_region_code,
  c.preferred_area_name,
  c.governorate,
  c.address as candidate_address,
  c.preferred_region_name,
  c.email as candidate_email,
  c.linkedin_url,
  c.nationality,
  c.gender,
  c.date_of_birth,
  c.marital_status,
  c.military_status,
  c.faculty,
  c.university,
  c.degree,
  c.graduation_year,
  c.grade,
  c.current_employer,
  c.current_job_title,
  c.years_experience,
  c.has_prior_work_experience,
  c.has_medical_rep_experience,
  c.medical_rep_employer,
  c.medical_rep_experience_from,
  c.medical_rep_experience_to,
  c.expected_salary,
  c.notice_period,
  public.ats_cv_names_text(c.position_specific_fields -> 'skills')          as cv_skills,
  public.ats_cv_names_text(c.position_specific_fields -> 'languages')       as cv_languages,
  public.ats_cv_names_text(c.position_specific_fields -> 'certifications')  as cv_certifications,
  public.ats_cv_education_text(c.position_specific_fields -> 'educationHistory') as cv_education,
  public.ats_cv_work_text(c.position_specific_fields -> 'workHistory')      as cv_work_history,
  c.professional_summary,
  c.declared_background,
  c.declared_experience,
  c.declared_expected_salary,
  c.screening_extra_answers ->> 'oc_english_level'      as screening_english_level,
  c.screening_extra_answers ->> 'oc_ms_office_outlook'  as screening_ms_office,
  c.screening_extra_answers ->> 'oc_booking_experience' as screening_booking_experience,
  c.screening_extra_answers ->> 'oc_sheraton_commute'   as screening_commute,
  c.screening_extra_answers ->> 'oc_start_date'         as screening_start_date,
  c.screening_extra_answers ->> 'oc_age_band'           as screening_age_band,
  c.source as candidate_source,
  c.created_at as candidate_created_at,
  c.status_changed_at as candidate_status_changed_at,
  c.status_note as candidate_status_note,
  c.manager_notified_name,
  c.manager_notified_at,
  c.manager_notified_area,
  c.manager_notified_region,
  c.sent_for_job_title,
  c.sent_for_area,
  c.sent_for_region,
  c.sent_for_line
from public.ats_files f
  left join public.ats_candidates c on c.id = f.candidate_id
  -- The FIRST intake event per file. DISTINCT ON keeps this subquery from being flattened, which
  -- is fine: it is 1.4k index-ordered rows and costs ~4 ms.
  left join (
    select distinct on (e.file_id)
      e.file_id, e.channel, e.provider_message_id, e.provider_uid,
      e.sender_display_name, e.sender_identifier, e.mailbox_label,
      e.source_channel_code, e.outcome, e.created_at as intake_event_at,
      -- The event's half of the queue key. See the header: WhatsApp matches on Meta's message id,
      -- email on mailbox + uid, anything else on NULL (matches nothing).
      case
        when e.channel = 'whatsapp' then e.provider_message_id
        when e.channel = 'email'    then e.mailbox_label
      end as queue_match_a,
      case
        when e.channel = 'whatsapp' then ''
        when e.channel = 'email'    then e.provider_uid
      end as queue_match_b
    from public.ats_cv_intake_events e
    where e.file_id is not null
    order by e.file_id, e.created_at
  ) ev on ev.file_id = f.id
  -- The queue's half. An email queue id is 'email:<mailbox>:<uidvalidity>:<uid>', so the mailbox is
  -- part 2 and the uid part 4 — the same split the email leg of the old OR made.
  left join (
    select
      q_1.channel, q_1.created_at, q_1.claimed_at, q_1.finished_at,
      q_1.status, q_1.attempts, q_1.last_error,
      case
        when q_1.channel = 'whatsapp' then q_1.provider_message_id
        when q_1.channel = 'email'    then split_part(q_1.provider_message_id, ':', 2)
      end as match_a,
      case
        when q_1.channel = 'whatsapp' then ''
        when q_1.channel = 'email'    then split_part(q_1.provider_message_id, ':', 4)
      end as match_b
    from public.ats_inbound_intake_queue q_1
  ) q
    on q.channel = ev.channel
   and q.match_a = ev.queue_match_a
   and q.match_b = ev.queue_match_b
where f.kind = 'cv';

comment on view public.ats_v_cv_lifecycle is
  'One row per CV file: arrival, intake, Phoenix save and Drive mirror, plus the candidate. '
  'Flattenable on purpose (no WITH) so ORDER BY/LIMIT readers defer the CV-text functions; '
  'the queue join is an equi-join on (channel, match_a, match_b). See 20260917190000.';

-- Restated so this file is self-contained: the feed reads as service_role, nobody else reads it.
revoke all on public.ats_v_cv_lifecycle from anon, authenticated;
grant select on public.ats_v_cv_lifecycle to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 3. Prove nothing moved, and that the shape that makes it fast survived.
-- ─────────────────────────────────────────────────────────────────────────────────

do $verify$
declare
  v_before_count bigint;
  v_before_checksum text;
  v_after_count bigint;
  v_after_checksum text;
  v_def text;
begin
  select row_count, checksum into v_before_count, v_before_checksum from cv_lifecycle_fingerprint_before;

  select count(*),
         md5(coalesce(string_agg(to_jsonb(v)::text, E'\n' order by v.saved_in_phoenix_at desc, v.file_id desc), ''))
    into v_after_count, v_after_checksum
  from public.ats_v_cv_lifecycle v;

  if v_after_count <> v_before_count then
    raise exception 'ats_v_cv_lifecycle row count changed: % before, % after', v_before_count, v_after_count;
  end if;

  if v_after_checksum <> v_before_checksum then
    raise exception 'ats_v_cv_lifecycle content changed (% rows): checksum % before, % after',
      v_after_count, v_before_checksum, v_after_checksum;
  end if;

  -- A future "tidy-up" back into CTEs would silently undo half of this migration, so refuse it.
  v_def := pg_get_viewdef('public.ats_v_cv_lifecycle'::regclass, true);
  if v_def ~* '^\s*with\s' then
    raise exception 'ats_v_cv_lifecycle must not start with WITH — a CTE-bearing view is never flattened';
  end if;
  if v_def !~* 'q\.match_a = ev\.queue_match_a' then
    raise exception 'ats_v_cv_lifecycle lost its equi-join on the queue key';
  end if;

  raise notice 'ats_v_cv_lifecycle unchanged: % rows, checksum %', v_after_count, v_after_checksum;
end
$verify$;

commit;

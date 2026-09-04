-- The CV-lifecycle view was showing a fraction of what Phoenix already knows about each candidate.
--
-- THE DEFECT, MEASURED ON PRODUCTION 2026-09-05 (982 files, 741 candidates). The view exposed
-- `preferred_area_name` and `preferred_region_code` — the area the CANDIDATE declared, written only
-- when they answer the preferences question. 114 of 982 rows had an area (12%) and 216 had a region
-- (22%). So the owner's live sheet carried an "Area" column that was blank for seven CVs in every
-- eight, which reads as "Phoenix does not know where these people are".
--
-- Phoenix does know. `ats_candidates.governorate` is filled for 565 of 741 candidates (76%) and was
-- simply never selected. The same is true of the rest of the CV:
--   university 647 (87%) · medical-rep experience 645 (87%) · degree 610 (82%)
--   graduation year 587 (79%) · current job title 554 (75%) · current employer 494 (67%)
--   faculty 448 (60%) · address 430 (58%) · email 421 (57%) · years of experience 387 (52%)
-- and the extracted CV body, which is the richest of the lot:
--   educationHistory 686 · skills 674 · workHistory 656 · languages 561 · certifications 435
-- plus the answers the candidate actually gave:
--   declared background 147 · declared experience 141 · declared expected salary 140
--   screening answers 63 (six questions, all six answered by all 63)
--
-- Everything below already exists on a table this view ALREADY JOINS. There is no new join and no
-- new table: `ats_candidates c` is joined on `c.id = f.candidate_id` exactly as before. This is a
-- widened SELECT list.
--
-- APPENDED, NEVER REORDERED. `create or replace view` refuses to drop, retype or reorder an
-- existing column, so every new field goes at the END. That is also what keeps the sheet safe: the
-- Apps Script finds its columns BY NAME out of the feed's header row, so existing columns keep
-- their meaning and a reader who has not updated their script sees exactly what they saw before.
--
-- `security_invoker = on` is restated deliberately. A plain `create or replace view` keeps the
-- existing options, but restating it means the guarantee is readable in this file rather than
-- inferred from a migration four weeks back — this view now carries names, phone numbers, home
-- addresses, dates of birth and salary expectations, and the invoker check is the whole reason it
-- is safe to put behind a bearer link at all.

-- ─────────────────────────────────────────────────────────────────────────────────
-- Flatteners for the extracted CV body.
--
-- The extraction stores arrays of objects — [{name}], [{degree, institution, year}],
-- [{jobTitle, employer, from, to}]. A spreadsheet cell cannot hold that, and shipping raw JSON into
-- the owner's sheet would be worse than shipping nothing: it is unreadable and it looks broken.
-- These render one readable line each.
--
-- Each tolerates a scalar array as well as an object array (`e #>> '{}'` is the element's own text),
-- because the extractor's shape has changed once already and a future change must degrade to plain
-- text rather than to NULL. Each is IMMUTABLE so the planner may inline it.
-- ─────────────────────────────────────────────────────────────────────────────────

create or replace function public.ats_cv_names_text(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(string_agg(coalesce(nullif(e ->> 'name', ''), e #>> '{}'), ', ' order by ord), '')
  from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end)
       with ordinality as t(e, ord)
  where coalesce(nullif(e ->> 'name', ''), e #>> '{}') is not null
$$;

comment on function public.ats_cv_names_text(jsonb) is
  'Skills / languages / certifications as one comma-separated line. Tolerates scalar arrays.';

create or replace function public.ats_cv_education_text(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(string_agg(line, ' · ' order by ord), '')
  from (
    select ord,
           nullif(
             concat_ws(' — ',
               nullif(e ->> 'degree', ''),
               nullif(e ->> 'institution', '')
             ) || coalesce(' (' || nullif(e ->> 'year', '') || ')', ''),
             ''
           ) as line
    from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end)
         with ordinality as t(e, ord)
  ) rows
  where line is not null
$$;

comment on function public.ats_cv_education_text(jsonb) is
  'Education history as "Degree — Institution (year)", joined by a middle dot.';

create or replace function public.ats_cv_work_text(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(string_agg(line, ' · ' order by ord), '')
  from (
    select ord,
           nullif(
             concat_ws(' — ',
               nullif(e ->> 'jobTitle', ''),
               nullif(e ->> 'employer', '')
             ) || coalesce(
               ' (' || coalesce(left(nullif(e ->> 'from', ''), 7), '?')
                    || '→'
                    || coalesce(left(nullif(e ->> 'to', ''), 7),
                                case when (e ->> 'isCurrent')::text = 'true' then 'now' else '?' end)
                    || ')',
               ''
             ),
             ''
           ) as line
    from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end)
         with ordinality as t(e, ord)
  ) rows
  where line is not null
$$;

comment on function public.ats_cv_work_text(jsonb) is
  'Work history as "Job title — Employer (YYYY-MM→YYYY-MM)", joined by a middle dot.';

revoke all on function public.ats_cv_names_text(jsonb) from public;
revoke all on function public.ats_cv_education_text(jsonb) from public;
revoke all on function public.ats_cv_work_text(jsonb) from public;
grant execute on function public.ats_cv_names_text(jsonb) to service_role;
grant execute on function public.ats_cv_education_text(jsonb) to service_role;
grant execute on function public.ats_cv_work_text(jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────
-- The view.
-- ─────────────────────────────────────────────────────────────────────────────────

create or replace view public.ats_v_cv_lifecycle
with (security_invoker = on)
as
with first_event as (
  select distinct on (e.file_id)
    e.file_id, e.channel, e.provider_message_id, e.provider_uid,
    e.sender_display_name, e.sender_identifier, e.mailbox_label,
    e.source_channel_code, e.outcome, e.created_at as intake_event_at
  from public.ats_cv_intake_events e
  where e.file_id is not null
  order by e.file_id, e.created_at
), queued as (
  select
    q_1.channel, q_1.provider_message_id, q_1.created_at, q_1.claimed_at,
    q_1.finished_at, q_1.status, q_1.attempts, q_1.last_error,
    case when q_1.channel = 'email' then split_part(q_1.provider_message_id, ':', 2) end as email_mailbox,
    case when q_1.channel = 'email' then split_part(q_1.provider_message_id, ':', 4) end as email_uid
  from public.ats_inbound_intake_queue q_1
)
select
  -- ── Unchanged, in their original order. Do not reorder or retype anything above the new block. ──
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

  -- ── New. Where the candidate is. ──
  -- `governorate` answers "which area" for 76% of candidates against 12% for the declared area
  -- above. It sits BESIDE the declared fields rather than replacing them, because they mean
  -- different things: governorate is where the person LIVES, preferred_area_name is where they
  -- asked to WORK. Reporting either as the other would be wrong in both directions.
  c.governorate,
  c.address as candidate_address,
  c.preferred_region_name,

  -- ── Who they are. ──
  c.email as candidate_email,
  c.linkedin_url,
  c.nationality,
  c.gender,
  c.date_of_birth,
  c.marital_status,
  c.military_status,

  -- ── What they studied. ──
  c.faculty,
  c.university,
  c.degree,
  c.graduation_year,
  c.grade,

  -- ── What they have done. ──
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

  -- ── The CV body the extractor read, rendered readable. ──
  public.ats_cv_names_text(c.position_specific_fields -> 'skills')          as cv_skills,
  public.ats_cv_names_text(c.position_specific_fields -> 'languages')       as cv_languages,
  public.ats_cv_names_text(c.position_specific_fields -> 'certifications')  as cv_certifications,
  public.ats_cv_education_text(c.position_specific_fields -> 'educationHistory') as cv_education,
  public.ats_cv_work_text(c.position_specific_fields -> 'workHistory')      as cv_work_history,
  c.professional_summary,

  -- ── What the candidate themself answered. ──
  -- These are the questions asked over WhatsApp. `declared_expected_salary` is the candidate's OWN
  -- figure and is deliberately separate from `expected_salary` above, which HR may have edited.
  c.declared_background,
  c.declared_experience,
  c.declared_expected_salary,
  c.screening_extra_answers ->> 'oc_english_level'      as screening_english_level,
  c.screening_extra_answers ->> 'oc_ms_office_outlook'  as screening_ms_office,
  c.screening_extra_answers ->> 'oc_booking_experience' as screening_booking_experience,
  c.screening_extra_answers ->> 'oc_sheraton_commute'   as screening_commute,
  c.screening_extra_answers ->> 'oc_start_date'         as screening_start_date,
  c.screening_extra_answers ->> 'oc_age_band'           as screening_age_band,

  -- ── How they reached us, and what has happened since. ──
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
  left join first_event ev on ev.file_id = f.id
  left join queued q
    on q.channel = ev.channel
   and (
        (ev.channel = 'whatsapp' and q.provider_message_id = ev.provider_message_id)
     or (ev.channel = 'email'    and q.email_mailbox = ev.mailbox_label
                                and q.email_uid     = ev.provider_uid)
       )
where f.kind = 'cv';

-- Restated so this file is self-contained: the feed reads as service_role, nobody else reads it.
revoke all on public.ats_v_cv_lifecycle from anon, authenticated;
grant select on public.ats_v_cv_lifecycle to service_role;

do $verify$
declare
  v_missing text[];
  v_gov_share numeric;
  v_work_share numeric;
begin
  select array_agg(want)
    into v_missing
  from unnest(array[
    'governorate','candidate_address','candidate_email','faculty','university','degree',
    'graduation_year','current_employer','current_job_title','years_experience',
    'has_medical_rep_experience','candidate_source','cv_skills','cv_education','cv_work_history',
    'declared_background','declared_expected_salary','screening_english_level',
    'preferred_area_name','drive_folder'
  ]) as want
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name  = 'ats_v_cv_lifecycle'
      and column_name = want
  );

  if v_missing is not null then
    raise exception 'ats_v_cv_lifecycle is missing columns after replace: %', v_missing;
  end if;

  -- The point of the whole migration: prove the new columns actually CARRY data, so that a join
  -- which silently resolves to nothing can never pass for success. Measured shares on production
  -- were 0.58 for governorate and 0.60 for work history across all 982 file rows; the floors below
  -- are deliberately well under those, because they must not fail on a quiet staging database —
  -- they exist to catch "every value is null", not to pin a number that legitimately moves.
  select count(governorate)::numeric    / greatest(count(*), 1) into v_gov_share  from public.ats_v_cv_lifecycle;
  select count(cv_work_history)::numeric / greatest(count(*), 1) into v_work_share from public.ats_v_cv_lifecycle;

  if (select count(*) from public.ats_v_cv_lifecycle) > 100 then
    if v_gov_share < 0.25 then
      raise exception 'governorate is filled for only % percent of rows — the candidate join is not landing', round(v_gov_share * 100);
    end if;
    if v_work_share < 0.25 then
      raise exception 'work history is filled for only % percent of rows — the extraction flattener is not landing', round(v_work_share * 100);
    end if;
  end if;
end
$verify$;

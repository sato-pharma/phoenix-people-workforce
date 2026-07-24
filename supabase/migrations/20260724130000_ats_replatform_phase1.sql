-- Recruitment / ATS re-platform, Phase 1 — decommission the June-era module, keep this
-- week's proven CV-extraction / DM-portal / email-WhatsApp-intake logic, moved onto a
-- freshly named `ats_` table set.
--
-- Context: the June 5 2026 recruitment_* tables were test data only (every row count is
-- 0 in production). Everything built this week (AI CV extraction, District Manager hiring
-- portal, email/WhatsApp inbound candidate intake, per-position field-schema framework)
-- is proven and kept, exactly as it behaves today, just re-platformed onto ats_* tables so
-- nothing of the retired June module survives underneath it. Adjacent June-era features
-- never touched this week (job postings/public careers page, offer letters, offer
-- approval chain, onboarding checklist items, and the older job_offers/job_offer_* offer
-- engine) are dropped outright.
--
-- Staging/production drift note: `recruitment_candidate_cv_extractions` already exists on
-- staging (this week's CV-extraction migration reached staging via main's auto-deploy) but
-- not on production; `recruitment_cv_intake_events`/`recruitment_email_intake_cursors` exist
-- on neither. The DO block below handles both starting states so this single migration is
-- correct on staging and production alike.
--
-- SAFE: every TRUNCATE/DROP TABLE below targets confirmed 0-row test-only data (verified via
-- direct row counts on production before writing this migration) — see the plan/PR description
-- for the full table-by-table verification.

begin;

-- ---------------------------------------------------------------------------------------
-- 1. Rename the 6 core pipeline tables (TRUNCATE first — test data only, confirmed 0 rows
--    in production; wipes whatever local/staging test rows exist too).
-- ---------------------------------------------------------------------------------------

truncate table public.recruitment_requisitions,
              public.recruitment_candidates,
              public.recruitment_applications,
              public.recruitment_application_events,
              public.recruitment_interviews,
              public.recruitment_files
  restart identity cascade;

alter table public.recruitment_requisitions rename to ats_requisitions;
alter table public.recruitment_candidates rename to ats_candidates;
alter table public.recruitment_applications rename to ats_applications;
alter table public.recruitment_application_events rename to ats_application_events;
alter table public.recruitment_interviews rename to ats_interviews;
alter table public.recruitment_files rename to ats_files;

-- Renamed indexes/constraints keep their old (recruitment_-prefixed) names automatically —
-- Postgres does not rename them on table rename. Harmless (they still function correctly
-- against the new table name); left as-is to avoid touching unrelated index definitions.

-- ---------------------------------------------------------------------------------------
-- 2. CV-extraction audit trail (ats_candidate_cv_extractions). Handles both starting
--    states: rename in place if the old table already reached this environment (staging),
--    otherwise create fresh (production).
-- ---------------------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'recruitment_candidate_cv_extractions'
  ) then
    execute 'truncate table public.recruitment_candidate_cv_extractions restart identity cascade';
    execute 'alter table public.recruitment_candidate_cv_extractions rename to ats_candidate_cv_extractions';
  else
    execute $ddl$
      create table public.ats_candidate_cv_extractions (
          id uuid default gen_random_uuid() not null,
          candidate_id uuid not null,
          file_id uuid,
          ai_model text not null,
          extracted_fields jsonb not null,
          applied_fields jsonb,
          created_by text,
          created_at timestamp with time zone default now() not null,
          constraint ats_candidate_cv_extractions_pkey primary key (id),
          constraint ats_candidate_cv_extractions_candidate_id_fkey
              foreign key (candidate_id) references public.ats_candidates(id) on update cascade on delete cascade,
          constraint ats_candidate_cv_extractions_file_id_fkey
              foreign key (file_id) references public.ats_files(id) on update cascade on delete set null
      )
    $ddl$;
  end if;
end
$$;

comment on table public.ats_candidate_cv_extractions is
    'One row per AI CV-extraction run: extracted_fields is the AI''s raw {field: {value, confidence}} proposal, applied_fields is what Talent Acquisition actually saved after reviewing/correcting it. Audit trail and future prompt-tuning signal, not a model-training pipeline.';

create index if not exists ats_candidate_cv_extractions_candidate_id_idx
    on public.ats_candidate_cv_extractions using btree (candidate_id);

alter table public.ats_candidate_cv_extractions enable row level security;

drop policy if exists phx_recruitment_candidate_cv_extractions_service_role on public.ats_candidate_cv_extractions;
drop policy if exists phx_ats_candidate_cv_extractions_service_role on public.ats_candidate_cv_extractions;
create policy phx_ats_candidate_cv_extractions_service_role
    on public.ats_candidate_cv_extractions
    to service_role using (true) with check (true);

grant all on table public.ats_candidate_cv_extractions to service_role;

-- Candidate CV-extraction fields (Medical Rep dedicated columns + the generic per-position
-- JSONB bucket). Guaranteed not present on production; already present on staging — either
-- way, `if not exists` makes this idempotent.
alter table public.ats_candidates
    add column if not exists address text,
    add column if not exists faculty text,
    add column if not exists university text,
    add column if not exists has_prior_work_experience boolean,
    add column if not exists has_medical_rep_experience boolean,
    add column if not exists medical_rep_employer text,
    add column if not exists medical_rep_experience_from date,
    add column if not exists medical_rep_experience_to date,
    add column if not exists position_specific_fields jsonb;

comment on column public.ats_candidates.medical_rep_employer is
    'Company where the candidate worked as a Medical Rep / in medical sales promotion, distinct from current_employer (which may be a different, non-medical job).';
comment on column public.ats_candidates.position_specific_fields is
    'Generic field storage for CV-extraction positions other than Medical Rep (which uses its own dedicated columns). Keyed by the field keys declared in that position''s CvPositionSchema.';

alter table public.ats_candidate_cv_extractions
    add column if not exists position_key text not null default 'medical_rep';

comment on column public.ats_candidate_cv_extractions.position_key is
    'Which CvPositionSchema (src/lib/recruitment/cv-field-schemas.ts) drove this extraction run.';

-- ---------------------------------------------------------------------------------------
-- 3. Inbound CV intake (email + WhatsApp) audit trail + IMAP polling cursor. Never reached
--    staging or production — safe to create fresh under the final ats_ names everywhere.
-- ---------------------------------------------------------------------------------------

create table if not exists public.ats_cv_intake_events (
    id uuid default gen_random_uuid() not null,
    channel text not null,
    mailbox_label text,
    provider_message_id text,
    provider_uid text,
    sender_identifier text,
    sender_display_name text,
    subject text,
    outcome text not null default 'processing',
    candidate_id uuid,
    file_id uuid,
    match_reason text,
    error_message text,
    raw_metadata jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint ats_cv_intake_events_pkey primary key (id),
    constraint ats_cv_intake_events_channel_check
        check (channel in ('email', 'whatsapp')),
    constraint ats_cv_intake_events_outcome_check
        check (outcome in (
            'processing', 'candidate_created', 'candidate_matched',
            'ignored_no_attachment', 'ignored_unsupported_attachment',
            'ignored_duplicate', 'error'
        )),
    constraint ats_cv_intake_events_candidate_id_fkey
        foreign key (candidate_id) references public.ats_candidates(id) on update cascade on delete set null,
    constraint ats_cv_intake_events_file_id_fkey
        foreign key (file_id) references public.ats_files(id) on update cascade on delete set null
);

comment on table public.ats_cv_intake_events is
    'One row per inbound email/WhatsApp message an intake poller or webhook attempted to turn into a candidate. The (channel, provider_message_id) unique index doubles as the idempotency claim key.';

create unique index if not exists ats_cv_intake_events_channel_msg_uniq
    on public.ats_cv_intake_events using btree (channel, provider_message_id)
    where provider_message_id is not null;

create index if not exists ats_cv_intake_events_candidate_id_idx
    on public.ats_cv_intake_events using btree (candidate_id);

create index if not exists ats_cv_intake_events_created_at_idx
    on public.ats_cv_intake_events using btree (created_at desc);

create table if not exists public.ats_email_intake_cursors (
    mailbox_label text not null,
    imap_uidvalidity bigint,
    last_processed_uid bigint not null default 0,
    updated_at timestamp with time zone default now() not null,
    constraint ats_email_intake_cursors_pkey primary key (mailbox_label)
);

comment on table public.ats_email_intake_cursors is
    'IMAP polling watermark per mailbox (last_processed_uid). A UIDVALIDITY change resets the cursor to 0 for that mailbox; the ats_cv_intake_events claim key is the safety net against reprocessing in that case.';

alter table public.ats_cv_intake_events enable row level security;
alter table public.ats_email_intake_cursors enable row level security;

drop policy if exists phx_ats_cv_intake_events_service_role on public.ats_cv_intake_events;
create policy phx_ats_cv_intake_events_service_role
    on public.ats_cv_intake_events
    to service_role using (true) with check (true);

drop policy if exists phx_ats_email_intake_cursors_service_role on public.ats_email_intake_cursors;
create policy phx_ats_email_intake_cursors_service_role
    on public.ats_email_intake_cursors
    to service_role using (true) with check (true);

grant all on table public.ats_cv_intake_events to service_role;
grant all on table public.ats_email_intake_cursors to service_role;

-- ---------------------------------------------------------------------------------------
-- 4. Drop the June-era adjacent features outright (job postings, offer letters, offer
--    approval chain, onboarding checklist items, and the older job_offers/job_offer_*
--    offer engine). Never touched by this week's work; per owner confirmation, decommission
--    with no migration path — this is test data (0 rows everywhere).
-- ---------------------------------------------------------------------------------------

drop table if exists public.recruitment_job_postings cascade;
drop table if exists public.recruitment_offer_letters cascade;
drop table if exists public.recruitment_onboarding_items cascade;
drop table if exists public.offer_approval_steps cascade;
drop table if exists public.job_offer_decision_events cascade;
drop table if exists public.job_offer_audit_logs cascade;
drop table if exists public.job_offers cascade;

-- ---------------------------------------------------------------------------------------
-- 5. Workflow registry: app_hire currently only allows from ["offer_accepted",
--    "pre_boarding"]. offer_accepted is now unreachable (the whole offer pipeline that
--    produced it is gone); add offer_initiated (the new direct-hire waypoint reached via
--    app_select) so markApplicationHired can actually fire. Additive only — pre_boarding
--    and the pre-existing offer_accepted entry are left in place.
-- ---------------------------------------------------------------------------------------

update public.workflow_registry_modules
set actions = (
  select jsonb_agg(
    case
      when action ->> 'key' = 'app_hire'
        then jsonb_set(
          action,
          '{from}',
          (select jsonb_agg(distinct v) from jsonb_array_elements_text(action -> 'from' || '["offer_initiated"]'::jsonb) as v)
        )
      else action
    end
  )
  from jsonb_array_elements(actions) as action
)
where module_key = 'recruitment';

notify pgrst, 'reload schema';

commit;

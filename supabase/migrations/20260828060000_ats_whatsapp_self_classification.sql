-- Recruitment / ATS — let a CV sender classify their own application over WhatsApp.
--
-- THE PROBLEM. Measured 2026-08-28 against production: 446 candidates, 227 of them (51%) arrived on
-- WhatsApp, and `applied_for_job_title` is filled on 60. Those 60 carry 41 DISTINCT spellings. So
-- the one field that decides which hiring manager a CV goes to is empty on 87% of the pool, and
-- where it is filled it is free text nobody can filter on reliably.
--
-- THE FIX. When a CV arrives, the applicant is asked three questions as tappable WhatsApp lists —
-- role, then region, then the areas inside that region. Their answers are their own statement of
-- intent in a fixed vocabulary, which is strictly better evidence than anything an extractor can
-- infer from the document. It costs nothing to ask: the applicant messaged us first, so every reply
-- sits inside an open 24-hour customer service window, where Meta does not bill non-template
-- messages.
--
-- Two parts:
--
-- 1. ats_whatsapp_classification_sessions — the conversation's state. One open row per sender,
--    holding which question they are on and what they have answered so far. It is NOT the answer of
--    record: once all three are in, they are copied onto the candidate (part 2) and the row is
--    marked complete. It exists because WhatsApp replies arrive as independent webhook events
--    minutes apart, with nothing but the sender's number tying them together.
--
-- 2. Three columns on ats_candidates. `applied_for_job_title` already exists and is the TOP rung of
--    the "Applying for" ladder in applied-for.ts ("a human typed it. Always wins") — a tapped role
--    is written there and needs no new read path. Region and area have no equivalent column: the
--    existing `governorate` is geography an extractor read off the CV, and `manager_notified_region`
--    /`manager_notified_area` record which MANAGER was notified, not what the candidate asked for.
--    Writing a candidate's answer into either of those would corrupt a different feature, so these
--    are new and explicitly named for what they hold.
--
-- Server-only. Every reader and writer goes through the service-role client (recruitmentDb()), which
-- bypasses RLS; RLS is enabled on the new table with no policies so the anon and authenticated roles
-- get nothing if it is ever reached directly.
--
-- Additive and reversible: one new table and three new nullable columns. No existing row is read,
-- rewritten or moved by this migration.

-- ── 1. Conversation state ───────────────────────────────────────────────────────────────────────

create table if not exists public.ats_whatsapp_classification_sessions (
    id uuid default gen_random_uuid() not null,
    -- The applicant's WhatsApp id, digits-only in Meta's convention (e.g. "201001234567").
    wa_id text not null,
    -- The BUSINESS line this conversation is on, so the reply goes back out of the same number the
    -- applicant messaged. Null falls back to WHATSAPP_PHONE_NUMBER_ID at send time.
    phone_number_id text,
    -- Which question is outstanding: job_title -> region -> area -> done.
    step text not null default 'job_title',
    -- Answers, filled in as they arrive. Role and region are stored as CODES (the stable key);
    -- the human-readable label is derived at read time from the same vocabulary the menus use.
    job_title_family text,
    region_code text,
    area_name text,
    -- The CV message that opened this conversation, and the last prompt we sent. Both are wamids,
    -- kept so a Meta webhook retry cannot double-prompt or double-apply.
    cv_wamid text,
    last_prompt_wamid text,
    -- Set once the answers have been copied onto a candidate, with the candidate they went to.
    applied_candidate_id uuid,
    applied_at timestamp with time zone,
    started_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    completed_at timestamp with time zone,
    constraint ats_whatsapp_classification_sessions_pkey primary key (id),
    constraint ats_whatsapp_classification_sessions_step_check
        check (step in ('job_title', 'region', 'area', 'done'))
);

comment on table public.ats_whatsapp_classification_sessions is
    'Per-sender state of the three-question WhatsApp self-classification flow (role, region, area) asked when a CV arrives. Not the answer of record: completed answers are copied onto ats_candidates and the row is marked done.';

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> region -> area -> done.';
comment on column public.ats_whatsapp_classification_sessions.last_prompt_wamid is
    'wamid of the most recent prompt sent, so a Meta webhook retry cannot re-ask the same question.';

-- At most ONE open conversation per sender. Without this a second CV from the same person mid-flow
-- would start a parallel conversation, and their next tap would be ambiguous between the two.
create unique index if not exists ats_whatsapp_classification_sessions_open_wa_id_idx
    on public.ats_whatsapp_classification_sessions using btree (wa_id)
    where completed_at is null;

-- Lookup for the applier: the most recent completed conversation for a sender, when the candidate
-- is created after the answers arrive.
create index if not exists ats_whatsapp_classification_sessions_wa_id_completed_idx
    on public.ats_whatsapp_classification_sessions using btree (wa_id, completed_at desc);

create index if not exists ats_whatsapp_classification_sessions_candidate_idx
    on public.ats_whatsapp_classification_sessions using btree (applied_candidate_id)
    where applied_candidate_id is not null;

alter table public.ats_whatsapp_classification_sessions enable row level security;

-- ── 2. The candidate's own declaration ──────────────────────────────────────────────────────────

alter table public.ats_candidates
    add column if not exists preferred_region_code text,
    add column if not exists preferred_area_name text,
    add column if not exists preferences_declared_at timestamp with time zone;

comment on column public.ats_candidates.preferred_region_code is
    'Company region the candidate chose for themselves (au.regions.region_code: CA/GZ/AB/D1/D2/UE/OT). Distinct from `governorate`, which is geography read off the CV, and from `manager_notified_region`, which records who was notified.';
comment on column public.ats_candidates.preferred_area_name is
    'Area the candidate chose for themselves, verbatim from au.canonical_areas.area_name.';
comment on column public.ats_candidates.preferences_declared_at is
    'When the candidate stated the above themselves. Null means nobody asked them or they never answered — never inferred.';

-- Finding candidates who have self-declared a territory (the recruitment pool filter).
create index if not exists ats_candidates_preferred_region_idx
    on public.ats_candidates using btree (preferred_region_code)
    where preferred_region_code is not null;

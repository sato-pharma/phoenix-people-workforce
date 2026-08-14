-- CV extraction for ANY job title.
--
-- Until now CV extraction ran against one hardcoded "Medical Rep" field set of 12 fields, four of
-- which were medical-rep-specific. Measured on production before this migration: 170 extractions,
-- every one producing the same 12 keys, 34% of all field slots empty — because a Payroll
-- Specialist CV was being asked Medical Rep questions. The company has 23 distinct job titles.
--
-- This migration adds the scalar fields the universal schema
-- (src/lib/recruitment/cv-field-schemas.ts) can now read, plus the table backing the per-field
-- include/exclude switch.
--
-- Storage split: scalars become real columns so they are filterable, indexable and exportable
-- ("show me every Egyptian candidate" must be a WHERE clause, not a jsonb scan). Repeating blocks
-- (work history, education history, certifications, skills, languages) stay in the existing
-- position_specific_fields jsonb, because they are variable-length arrays.
--
-- Additive only. No column is dropped or retyped, no existing row is rewritten, and every new
-- column is nullable — historical candidates simply carry NULL for fields their extraction run
-- never asked about.

-- ---------------------------------------------------------------------------
-- 1. New scalar columns on ats_candidates.
-- ---------------------------------------------------------------------------

alter table public.ats_candidates
    add column if not exists whatsapp text,
    add column if not exists linkedin_url text,
    add column if not exists nationality text,
    add column if not exists date_of_birth date,
    add column if not exists place_of_birth text,
    add column if not exists gender text,
    add column if not exists marital_status text,
    add column if not exists military_status text,
    add column if not exists current_job_title text,
    add column if not exists professional_summary text,
    add column if not exists current_role_responsibilities text,
    add column if not exists degree text,
    add column if not exists graduation_year integer,
    add column if not exists grade text;

comment on column public.ats_candidates.nationality is
    'Nationality exactly as stated on the CV. Never inferred from name, university or phone country code. Backs the Egyptian-nationals-only hiring rule, which is why this is a filterable column rather than jsonb.';

comment on column public.ats_candidates.current_job_title is
    'The CANDIDATE''S OWN current/most recent job title from their CV — not the vacancy applied for. This field is what makes extraction job-title-agnostic: the title is now read from the CV instead of chosen as a template beforehand.';

comment on column public.ats_candidates.position_specific_fields is
    'Repeating CV blocks keyed by the array field keys in src/lib/recruitment/cv-field-schemas.ts: workHistory, educationHistory, certifications, skills, languages. Each holds an array of objects shaped by that field''s itemFields. Scalars live in dedicated columns, not here.';

-- Nationality drives a hard hiring gate, so it gets an index; the rest are read per-candidate.
create index if not exists ats_candidates_nationality_idx
    on public.ats_candidates (nationality)
    where nationality is not null;

create index if not exists ats_candidates_current_job_title_idx
    on public.ats_candidates (current_job_title)
    where current_job_title is not null;

-- ---------------------------------------------------------------------------
-- 2. Per-field include/exclude switch.
-- ---------------------------------------------------------------------------
-- One row per field key that has been explicitly turned OFF or back ON. A field with no row here
-- is ENABLED — "capture everything" is the default, and a fresh database needs no seeding.
-- Disabling a field removes it from the AI request schema entirely (not merely hidden in the UI),
-- so a switched-off field costs no output tokens.

create table if not exists public.ats_cv_field_settings (
    field_key text not null,
    enabled boolean not null default true,
    updated_by text,
    updated_at timestamp with time zone not null default now(),
    constraint ats_cv_field_settings_pkey primary key (field_key)
);

comment on table public.ats_cv_field_settings is
    'Per-field on/off switch for CV extraction. ABSENT ROW MEANS ENABLED — this table records only deviations from "capture everything", so it is normally near-empty. field_key matches a key in universalCvFields (src/lib/recruitment/cv-field-schemas.ts); a stale key for a field that no longer exists is ignored at read time rather than erroring.';

comment on column public.ats_cv_field_settings.enabled is
    'false removes the field from the AI request schema, the review board and the candidate panel. Identity fields (fullName/email/phone) are refused server-side regardless of what is stored here — candidate matching depends on them.';

alter table public.ats_cv_field_settings enable row level security;

-- Consistent with the rest of this schema: all reads/writes go through the service-role client in
-- the application layer (visibility here is application-scoped, not RLS-scoped), so no
-- `authenticated` grant is issued. See docs/security/ and the RLS-without-grant note in AGENTS.
grant select, insert, update, delete on public.ats_cv_field_settings to service_role;

-- ---------------------------------------------------------------------------
-- 3. Make the new shape visible to PostgREST immediately.
-- ---------------------------------------------------------------------------
-- Every recruitment write goes through the Supabase JS client, i.e. through PostgREST, which
-- serves from a cached schema. Without this, the first updateCandidate that sets one of the 14 new
-- columns fails with "column not found in the schema cache" until the cache happens to refresh on
-- its own — the migration would read as applied while the feature stayed broken.
notify pgrst, 'reload schema';

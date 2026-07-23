-- AI CV extraction for recruitment candidates (Medical Rep field set, phase 1).
--
-- Adds the Medical-Rep-specific fields Talent Acquisition needs on a candidate record
-- (address/faculty/university/prior-experience/medical-rep-experience), sourced going
-- forward from an AI CV-extraction step rather than manual typing alone. Duration of the
-- medical-rep tenure is intentionally NOT stored — it is derived from the from/to dates at
-- read time so it can never drift out of sync with them.
--
-- recruitment_candidate_cv_extractions is the audit trail for each AI extraction run: what
-- the AI proposed (with per-field confidence) versus what Talent Acquisition actually saved
-- after reviewing/correcting it. This is a correction log for future prompt tuning, not a
-- model-training pipeline.

begin;

alter table public.recruitment_candidates
    add column if not exists address text,
    add column if not exists faculty text,
    add column if not exists university text,
    add column if not exists has_prior_work_experience boolean,
    add column if not exists has_medical_rep_experience boolean,
    add column if not exists medical_rep_employer text,
    add column if not exists medical_rep_experience_from date,
    add column if not exists medical_rep_experience_to date;

comment on column public.recruitment_candidates.medical_rep_employer is
    'Company where the candidate worked as a Medical Rep / in medical sales promotion, distinct from current_employer (which may be a different, non-medical job).';

create table if not exists public.recruitment_candidate_cv_extractions (
    id uuid default gen_random_uuid() not null,
    candidate_id uuid not null,
    file_id uuid,
    ai_model text not null,
    extracted_fields jsonb not null,
    applied_fields jsonb,
    created_by text,
    created_at timestamp with time zone default now() not null,
    constraint recruitment_candidate_cv_extractions_pkey primary key (id),
    constraint recruitment_candidate_cv_extractions_candidate_id_fkey
        foreign key (candidate_id) references public.recruitment_candidates(id) on update cascade on delete cascade,
    constraint recruitment_candidate_cv_extractions_file_id_fkey
        foreign key (file_id) references public.recruitment_files(id) on update cascade on delete set null
);

comment on table public.recruitment_candidate_cv_extractions is
    'One row per AI CV-extraction run: extracted_fields is the AI''s raw {field: {value, confidence}} proposal, applied_fields is what Talent Acquisition actually saved after reviewing/correcting it. Audit trail and future prompt-tuning signal, not a model-training pipeline.';

create index if not exists recruitment_candidate_cv_extractions_candidate_id_idx
    on public.recruitment_candidate_cv_extractions using btree (candidate_id);

alter table public.recruitment_candidate_cv_extractions enable row level security;

create policy phx_recruitment_candidate_cv_extractions_service_role
    on public.recruitment_candidate_cv_extractions
    to service_role using (true) with check (true);

grant all on table public.recruitment_candidate_cv_extractions to service_role;

notify pgrst, 'reload schema';

commit;

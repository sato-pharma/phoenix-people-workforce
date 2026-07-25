-- Recruitment CV extraction — per-position field-schema framework.
--
-- Medical Rep keeps its dedicated columns from the prior migration untouched. This adds two
-- purely additive columns so a FUTURE position (defined in src/lib/recruitment/
-- cv-field-schemas.ts, storage: "jsonb") can store its own fields without a new migration per
-- position, and so each extraction audit row records which position's schema produced it.

begin;

alter table public.recruitment_candidates
    add column if not exists position_specific_fields jsonb;

comment on column public.recruitment_candidates.position_specific_fields is
    'Generic field storage for CV-extraction positions other than Medical Rep (which uses its own dedicated columns). Keyed by the field keys declared in that position''s CvPositionSchema.';

alter table public.recruitment_candidate_cv_extractions
    add column if not exists position_key text not null default 'medical_rep';

comment on column public.recruitment_candidate_cv_extractions.position_key is
    'Which CvPositionSchema (src/lib/recruitment/cv-field-schemas.ts) drove this extraction run.';

notify pgrst, 'reload schema';

commit;

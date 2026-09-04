-- Which package an uploaded template belongs to.
--
-- The owner, 2026-09-04: "I want to be able to group documents to hiring or resignation or other."
--
-- The screen has always had two packages — the New hires package and the Leaver package — because a
-- person is only ever arriving or leaving on the day HR prints. The ten built-in documents are sorted
-- into them by the code (`HIRING_DOCUMENTS`, `EXIT_DOCUMENTS` and their siblings in types.ts), and
-- that sorting is not a preference: Form 1 is a joining form because the insurance office says so.
--
-- AN UPLOADED TEMPLATE HAS NO SUCH RULE TO READ, so it has to be told. Until now every company
-- template landed in one undifferentiated list at the bottom of the page, which is fine for two and
-- useless for twenty. This column is the answer, and it is on the VERSION row rather than a separate
-- table for the same reason everything else here is: replacing a template's artwork creates a new
-- version, and a template that moved from the joining package to the leaving package between
-- versions should print in the package it was in when it was signed.
--
-- THREE VALUES, and 'other' is a real answer rather than a null.
--
--   joining  — printed when somebody arrives. Shows in the New hires package.
--   leaving  — printed when somebody goes: a resignation, an exit form, a clearance. Shows in the
--              Leaver package. Named for the package rather than for "resignation", because that
--              package already holds Form 6 and a mutual-termination agreement, and a group named
--              after one of its members reads as excluding the others.
--   other    — everything a career does not begin or end with: a medical enrolment form, a bank
--              mandate, a training certificate. Shows in its own section.
--
-- DEFAULT 'other', deliberately. A template uploaded before this column existed was filed under no
-- package at all, and 'other' is exactly what that means — it is not a guess that could be wrong,
-- it is the honest description of a paper nobody has sorted yet.

begin;

alter table public.hiring_pack_custom_templates
  add column if not exists document_group text not null default 'other';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hiring_pack_custom_templates'::regclass
      and conname = 'hiring_pack_custom_templates_group_known'
  ) then
    alter table public.hiring_pack_custom_templates
      add constraint hiring_pack_custom_templates_group_known
      check (document_group in ('joining', 'leaving', 'other'));
  end if;
end
$$;

comment on column public.hiring_pack_custom_templates.document_group is
  'Which package this template prints in: joining (New hires), leaving (Leaver), or other. Set at '
  'upload and carried per version, so a template that changed package between versions still prints '
  'in the package it was in when it was signed.';

-- Listing a package reads (group, status) and orders by name. The partial index keeps the common
-- read — the current templates in one package — off a sequential scan as the list grows.
create index if not exists hiring_pack_custom_templates_group_idx
  on public.hiring_pack_custom_templates (document_group, name)
  where status = 'current';

commit;

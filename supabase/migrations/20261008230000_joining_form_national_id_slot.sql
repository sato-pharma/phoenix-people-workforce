-- joining_form_national_id_slot
--
-- WHAT THIS CHANGES: additive only — one nullable column, one check, one partial unique index, and
--   one UPDATE that marks at most the single "National ID copy" checklist slot.
--   * hiring_document_definitions.joining_form_upload — which checklist slot a photo the candidate
--     uploads on the offer joining form is filed into. Only 'national_id' exists today.
-- WHY: owner, 2026-10-08 — the joining form makes the candidate upload photos of the national ID
--   (front and back). Submit files them into the Hiring Documents checklist for the new record and
--   ticks the slot, so HR does not chase the copy.
--   A COLUMN, NOT A MATCH ON THE NAME — the same reasoning as
--   20260904234000_hiring_document_definitions_name_their_paper.sql: `name` is admin-editable free
--   text, and renaming the slot must not silently stop the filing. The name is matched here once,
--   the one moment it is known; after this the column is the mechanism. A slot renamed before this
--   runs stays NULL, and the joining form then tells HR the photos had nowhere to file.
-- ROLLBACK:
--   drop index if exists public.hiring_document_definitions_one_slot_per_joining_upload;
--   alter table public.hiring_document_definitions drop constraint if exists hiring_document_definitions_joining_form_upload_known;
--   alter table public.hiring_document_definitions drop column if exists joining_form_upload;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.hiring_document_definitions
  add column if not exists joining_form_upload text;

comment on column public.hiring_document_definitions.joining_form_upload is
  'Which candidate upload on the offer joining form is filed into this slot: national_id. NULL means nothing from the joining form files here. A column rather than a match on `name`, which is admin-editable free text.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.hiring_document_definitions'::regclass
      and conname = 'hiring_document_definitions_joining_form_upload_known'
  ) then
    alter table public.hiring_document_definitions
      add constraint hiring_document_definitions_joining_form_upload_known
      check (joining_form_upload is null or joining_form_upload in ('national_id'));
  end if;
end
$$;

create unique index if not exists hiring_document_definitions_one_slot_per_joining_upload
  on public.hiring_document_definitions (joining_form_upload)
  where joining_form_upload is not null;

-- The seeding: re-runnable, and it never overwrites a link somebody has since set by hand.
update public.hiring_document_definitions
   set joining_form_upload = 'national_id'
 where joining_form_upload is null
   and name = 'National ID copy'
   and not exists (
     select 1 from public.hiring_document_definitions where joining_form_upload = 'national_id'
   );

commit;

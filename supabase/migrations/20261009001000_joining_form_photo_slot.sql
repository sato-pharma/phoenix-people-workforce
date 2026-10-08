-- joining_form_photo_slot
--
-- WHAT THIS CHANGES: additive only — the joining-form upload check widens from ('national_id') to
--   ('national_id', 'photo'), and one UPDATE marks at most the single "(6) personal photos" slot.
-- WHY: owner, 2026-10-08 — the joining form asks the candidate for a photo (optional). Submit makes it
--   the new record's Phoenix profile photo AND files it on Hiring Documents under "(6) personal photos"
--   — WITHOUT ticking that slot: it asks for six printed photos for the paper file, and HR still
--   collects them (his ruling, the same evening). Same column mechanism as
--   20261008230000_joining_form_national_id_slot.sql — never a match on the admin-editable name after
--   this one moment.
-- ROLLBACK:
--   update public.hiring_document_definitions set joining_form_upload = null where joining_form_upload = 'photo';
--   alter table public.hiring_document_definitions drop constraint if exists hiring_document_definitions_joining_form_upload_known;
--   alter table public.hiring_document_definitions add constraint hiring_document_definitions_joining_form_upload_known
--     check (joining_form_upload is null or joining_form_upload in ('national_id'));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.hiring_document_definitions
  drop constraint if exists hiring_document_definitions_joining_form_upload_known;

alter table public.hiring_document_definitions
  add constraint hiring_document_definitions_joining_form_upload_known
  check (joining_form_upload is null or joining_form_upload in ('national_id', 'photo'));

comment on column public.hiring_document_definitions.joining_form_upload is
  'Which candidate upload on the offer joining form is filed into this slot: national_id (ticks it) or photo (filed, never ticks). NULL means nothing from the joining form files here. A column rather than a match on `name`, which is admin-editable free text.';

-- The seeding: re-runnable, and it never overwrites a link somebody has since set by hand.
update public.hiring_document_definitions
   set joining_form_upload = 'photo'
 where joining_form_upload is null
   and name = '(6) personal photos'
   and not exists (
     select 1 from public.hiring_document_definitions where joining_form_upload = 'photo'
   );

commit;

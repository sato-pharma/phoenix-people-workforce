-- Where a company template's confirmed paper gets filed — chosen, never invented.
--
-- THE TRAP THIS AVOIDS. `getHiringDocumentsDashboard` builds every employee crossed with every
-- ACTIVE definition, so a checklist slot is not a folder — it is a requirement asserted against the
-- whole company. Creating one automatically per uploaded template, which is the obvious way to make
-- an uploaded paper filable, would put "B2PROBE enrolment form — missing" against all 186 employees
-- at once, for a paper only three of them will ever sign. The checklist would fill with noise on
-- the first upload and there would be no way back that did not involve deleting rows by hand.
--
-- So a template POINTS AT a slot that already exists. NULL is the default and means the paper
-- prints and is not filed — which is honest, is said on the screen rather than left to be
-- discovered, and is what every template already uploaded will read as.
--
-- ON DELETE SET NULL, not cascade and not restrict. A retired checklist slot must not delete a
-- template — the template is the artwork people print, and losing it because a slot was tidied away
-- would be catastrophic and completely unrelated to what the person tidying meant. Nor should it
-- block the tidying. The template simply stops filing, which is the same state it started in.
--
-- PER VERSION, like every other column on this table. A template that changed where it files
-- between versions keeps, on each archived version, the slot it filed into at the time.

begin;

alter table public.hiring_pack_custom_templates
  add column if not exists files_under_document_id uuid
    references public.hiring_document_definitions (id)
    on delete set null;

comment on column public.hiring_pack_custom_templates.files_under_document_id is
  'Which hiring-document checklist slot a confirmed copy of this paper is filed under. NULL means it prints but is not filed. Deliberately a pointer at an EXISTING definition rather than one created per template: the hiring-documents dashboard is every employee crossed with every active definition, so inventing a slot here would assert a new missing document against every employee in the company.';

create index if not exists hiring_pack_custom_templates_files_under_idx
  on public.hiring_pack_custom_templates (files_under_document_id)
  where files_under_document_id is not null;

commit;

notify pgrst, 'reload schema';

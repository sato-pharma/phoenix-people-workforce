-- hiring_document_sheet_header
--
-- WHAT THIS CHANGES: a nullable `sheet_header` column on public.hiring_document_definitions, and
--   one row using it.
--
-- WHY. The Employee Master builds every document column's header as `<name> (document)`. HR's own
--   rebuilt sheet has one that does not follow that shape — "Medical check (document) S 111", with
--   the form number typed on after the suffix — and the owner asked for her sheet verbatim, this
--   cell included (2026-09-30). The alternatives were both worse: special-casing one header in the
--   builder, or folding "(document)" into the document's own name, which would put it on the
--   Hiring Documents screen where HR reads "Medical check S 111" and nothing else.
--
--   So the header becomes a per-definition override. The name stays the name HR reads on the
--   screen; `sheet_header` is what the sheet prints. Null for every other row, which keeps them on
--   the computed form.
--
-- THE SUFFIX IS STILL LOAD-BEARING, and the override cannot drop it. A column header is what the
--   upload matches fields on, so a document named "Position" or "Status" would, unsuffixed, be read
--   back as that employee field and overwrite it with the word "Submitted". `buildHiringDocumentColumns`
--   therefore IGNORES an override that does not contain "(document)" and falls back to the computed
--   header — a rule, not a convention: `tests/employee-master-workbook.test.ts` pins both halves.
--
-- ROLLBACK:
--   alter table public.hiring_document_definitions drop column if exists sheet_header;
--   The code must stop naming the column before it is dropped, or every read of the checklist
--   42703s — PostgREST answers a missing column by failing the WHOLE read, not by nulling one field.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This adds an empty nullable column and writes one row. It deletes nothing and renames nothing.

begin;

alter table public.hiring_document_definitions
  add column if not exists sheet_header text;

comment on column public.hiring_document_definitions.sheet_header is
  'What the Employee Master sheet prints as this document''s column header, when it differs from the computed "<name> (document)". Null for almost every row. It MUST still contain "(document)" — the builder ignores an override that does not, because that suffix is what keeps a document name out of the upload''s field alias table.';

update public.hiring_document_definitions
set sheet_header = 'Medical check (document) S 111'
where name = 'Medical check S 111';

commit;

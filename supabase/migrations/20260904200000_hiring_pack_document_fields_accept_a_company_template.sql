-- A box dropped on an UPLOADED template could not be saved at all.
--
-- Found by printing one, which is the only way it could have been found: the renderer works, the
-- print route resolves the template, the artwork streams, the blank form comes out correctly — and
-- the moment somebody drags the first box onto it, the write is refused by
-- `hiring_pack_document_fields_document_known`. The field layer's `document` column was pinned to
-- the ten documents that existed when it was built (20260903201500), and company templates arrived
-- afterwards.
--
-- THE PIN WAS RIGHT AND STAYS. That constraint's job is to stop a typo becoming a row nothing will
-- ever draw: a layout row naming a document this system cannot print is a box that silently never
-- appears on any paper, and nothing downstream would report it — the print route simply never asks
-- for that document's layer. So this WIDENS the predicate rather than dropping it.
--
-- ADMITTED: the ten, and `custom:<uuid>`. Refused, still: a bare `custom:`, a truncated uuid, a
-- template's NAME typed in by hand, an eleventh built-in somebody invented. That is the same shape
-- `asPrintableDocument` narrows to in the application and the same shape the print route validates
-- before it looks anything up — the difference being that this one cannot be bypassed by a caller
-- that forgot to validate.
--
-- CASE-INSENSITIVE (`~*`) so the database is never STRICTER than the application. `isUuid` in
-- types.ts carries the `i` flag; a constraint that refused what the app accepts would turn a
-- validated write into a 500 at the last step, which is precisely the failure this migration exists
-- to end.
--
-- WHY A PATTERN AND NOT A FOREIGN KEY. The document names a template's stable KEY, and
-- `hiring_pack_custom_templates` holds one row per VERSION of that key — several rows share it, so
-- there is nothing single to point a reference at. Which version a layout belongs to is already
-- carried separately, in `template_version_id`: that is what scopes a layer to the artwork it was
-- measured against, and it is why replacing a template's artwork cannot move old boxes onto a page
-- nobody re-measured.

begin;

alter table public.hiring_pack_document_fields
  drop constraint if exists hiring_pack_document_fields_document_known;

alter table public.hiring_pack_document_fields
  add constraint hiring_pack_document_fields_document_known check (
    document in (
      'contract', 'form1', 'workerDataForm', 'custodyLaptop', 'custodyMobile',
      'form6', 'resignation', 'mutualTermination', 'clearanceEmployee', 'clearanceCompany'
    )
    or document ~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

comment on column public.hiring_pack_document_fields.document is
  'Which document these coordinates belong to: one of the ten built-in papers, or a company template as custom:<uuid> where the uuid is the template''s stable key. The CHECK constraint mirrors asPrintableDocument in src/lib/hiring-pack/document-registry.ts.';

commit;

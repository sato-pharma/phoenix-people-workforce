-- The field layer learns a third kind of field: a MARK — the company stamp, or the stored
-- signature — placed on a paper by hand.
--
-- WHY. The owner, 2026-09-29: "in HR forms I want to have the option to add the Sato stamp seal and
-- my signature and be able to move and drag them freely in any form."
--
-- This does NOT reverse the ruling recorded the same day in `src/lib/hiring-pack/house-identity.ts`,
-- which took the seal OUT of every hiring renderer because "a document that arrives pre-stamped is a
-- document nobody stamped". That ruling is about a stamp the renderer draws by itself, on every copy,
-- whether or not anyone decided to stamp it — and it still holds: no compiled layout table places a
-- mark and no renderer emits one. A row in THIS table exists only because a person put it there, on
-- one document, at one version, and it is listed, draggable and deletable like every other field.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT CHANGES: one CHECK constraint. `source_kind` admits 'mark', and a mark row carries the mark's
-- NAME in `value_key` with `literal_text` null.
--
-- `value_key` IS REUSED RATHER THAN A NEW COLUMN ADDED. The mark vocabulary is closed and two words
-- long ('stamp', 'signature'), so a column of its own would be NULL on every other row in the table
-- for ever. The reader (`documentFieldFromRecord`) validates the name against that same closed list
-- and drops a row it cannot read, so a hand-written row naming a third mark is inert rather than
-- rendered as something else.
--
-- NO ARTWORK IS STORED HERE, deliberately. The row says WHICH mark; what that mark looks like is
-- resolved when the paper is drawn — the seal from `public/brand/sato-hr-seal.svg`, the signature
-- from a private Storage bucket. Storing the image on the row would freeze a signature into a
-- layout, so replacing the signature would leave every placement made before it printing the old one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- ADDITIVE AND REVERSIBLE. No row is touched, no column added, no column dropped: the constraint is
-- replaced by one that admits strictly MORE than the old one did. Every row the old constraint
-- allowed, the new one allows. Reversing it means restoring the previous constraint, which is only
-- possible while no mark row exists — which is the honest position: a mark row is a field somebody
-- placed on a document, and dropping it silently would un-stamp papers nobody was told about.
--
-- That matters because production has NO PITR: seven daily physical backups at one-day granularity,
-- restoring the whole database, are the entire recovery story.

begin;

alter table public.hiring_pack_document_fields
  drop constraint if exists hiring_pack_document_fields_source_paired;

alter table public.hiring_pack_document_fields
  add constraint hiring_pack_document_fields_source_paired check (
    (source_kind = 'value' and value_key is not null and length(btrim(value_key)) > 0 and literal_text is null)
    or (source_kind = 'literal' and literal_text is not null and value_key is null)
    -- A mark names itself in `value_key` and prints no text at all.
    or (source_kind = 'mark' and value_key in ('stamp', 'signature') and literal_text is null)
  );

-- A MARK IS ALWAYS AN ADDITION, NEVER AN OVERRIDE. An override keeps the COMPILED placement's own
-- kind — `movedPlacement` in field-layout.ts rewrites geometry inside the shape the default already
-- has — so a mark pointed at a compiled key would be drawn as that key's TEXT placement and print
-- nothing at all, leaving somebody looking at an unstamped page with no error anywhere to explain
-- it. There is also nothing to override: no compiled table places a picture. The API refuses it
-- (`parseDocumentFieldWrite`); this is the second lock, in the same spirit as
-- `hiring_pack_document_fields_hide_is_an_override` beside it.
alter table public.hiring_pack_document_fields
  drop constraint if exists hiring_pack_document_fields_mark_is_an_addition;

alter table public.hiring_pack_document_fields
  add constraint hiring_pack_document_fields_mark_is_an_addition check (
    source_kind <> 'mark' or default_key is null
  );

comment on column public.hiring_pack_document_fields.source_kind is
  'What the field prints. ''value'' reads the employee''s record through the same values map every compiled placement reads. ''literal'' prints a fixed string and must never look like data. ''mark'' prints a PICTURE — the company stamp or the stored HR signature, named in value_key — placed by hand by an operator; no compiled table and no renderer ever produces one, which is what separates it from the auto-drawn seal the owner removed on 2026-09-29.';

commit;

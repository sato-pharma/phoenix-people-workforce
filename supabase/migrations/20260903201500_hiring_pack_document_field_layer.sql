-- Hiring pack — the field layer behind "add any field wherever I want, drag and drop, full control".
--
-- The owner, 2026-09-03: *"i want to be able to add anyfield wherever i want and edit text and
-- drage drop fields and full control"*, across every document, saved live.
--
-- ── WHAT THIS TABLE IS ──────────────────────────────────────────────────────────────────────────
--
-- An OVERLAY on the compiled layout tables, never a replacement for them. Where a value prints today
-- is decided by TypeScript — form1-layout.ts and its three siblings hold coordinates transcribed out
-- of the government's own PDFs, and the six typeset documents place nothing at all. A row here does
-- one of three things to that: moves a compiled placement, hides one, or adds a field that was never
-- compiled.
--
-- The compiled tables stay the default and stay the truth. "Reset this document" is a delete of
-- these rows and nothing else, and it returns the paper to the measured original. That matters most
-- on the four government forms, whose coordinates are readings off the Authority's artwork and are
-- therefore correct by construction: a layout somebody dragged is an opinion, and the measurement
-- has to survive the opinion turning out to be wrong.
--
-- ── WHY A ROW IS SCOPED TO A TEMPLATE VERSION ───────────────────────────────────────────────────
--
-- template_version_id is the id from template-registry.ts, and it is what makes a flow-surface
-- anchor safe. A field on a typeset document hangs off a CSS path into the document's own markup;
-- a path is only stable if the markup is. It is: replacing a document's text creates a NEW version
-- and archives the old one — the owner's rule of 2026-08-30, *"any paper I replace, it goes to the
-- archive"* — so the markup a path was recorded against is the markup it is resolved against,
-- permanently. It also means a reprint of a contract signed in August reproduces August's layout,
-- not today's, which is the same guarantee the archive already gives for the text.
--
-- ── PAGE ROWS AND FLOW ROWS ─────────────────────────────────────────────────────────────────────
--
-- The ten documents are two genuinely different things and one coordinate model across both would
-- be a lie. form1, form6, resignation and mutualTermination are fixed-size artwork: one printed side
-- per DOM node, so (page, x, y) lands on the same millimetre for every employee. The other six are
-- typeset and flow across as many A4 pages as the text needs — there is no per-page node and no
-- stable page coordinate, because a longer name or an extra address line moves every break. Those
-- rows anchor to a block instead and carry an offset from it, so a field dropped beside مادة (7)
-- stays beside مادة (7).
--
-- A row is therefore one or the other, enforced by a CHECK: page set and anchor null, or anchor set
-- and page null. Neither is not a placement, and both is two placements that will disagree.
--
-- ── employee_hr_id: NULL MEANS EVERY EMPLOYEE, AND THAT IS THE ONLY THING v1 WRITES ─────────────
--
-- Layout is a property of the DOCUMENT, not of a person: moving a box on Form 1 moves it on every
-- Form 1, which is what designing a form means. A one-off note on one person's copy is already
-- served by the existing "Type anywhere" mode, which prints and deliberately does not save.
--
-- The column is here from day one, nullable, because the unique index below has to account for it.
-- Adding it later would mean dropping and recreating that index, and an index rebuilt wrongly would
-- silently permit two overrides of the same placement — one of which would win at random. Reserving
-- the column costs nothing; reserving the index shape is the actual point.
--
-- ── NOT APPLIED ────────────────────────────────────────────────────────────────────────────────
--
-- This file has NOT been applied to any environment. Applying it to production is a protected action
-- and needs the owner's separate approval. Production has no PITR — seven daily physical backups are
-- the whole recovery story — though this migration is purely additive and reversible by dropping the
-- table, so nothing existing is at risk either way.
--
-- ADDITIVE. One new table, no existing row touched, nothing dropped.

begin;

create table if not exists public.hiring_pack_document_fields (
  id uuid primary key default gen_random_uuid(),
  -- Which paper. The vocabulary is pinned here as well as at the API boundary: a row naming a
  -- document nothing renders is a field that can never be seen, found or deleted from any screen.
  document text not null,
  -- The version of that paper this layout belongs to. See the header — this is what makes a flow
  -- anchor stable and what makes an archived document reprint with the layout it was signed under.
  template_version_id text not null,
  -- NULL means every employee, which is all v1 writes. See the header.
  employee_hr_id text,
  -- The compiled placement this row replaces, by its key. NULL means the row ADDS a field that no
  -- compiled table has. An override for a key a later version removed is ignored at render time
  -- rather than promoted to a new field: its coordinates refer to artwork nobody has re-checked.
  default_key text,
  -- A compiled default suppressed. Only meaningful on an override — an added field is deleted, not
  -- hidden, because there is nothing underneath it to fall back to.
  hidden boolean not null default false,
  -- Page surfaces: which printed side, 1-based.
  page smallint,
  -- Flow surfaces: where it hangs, and how far from there. A CSS path resolved against the rendered
  -- document, plus an offset in points.
  anchor_selector text,
  anchor_dx numeric(8, 2),
  anchor_dy numeric(8, 2),
  -- Geometry in POINTS, origin at the top-left, the same coordinate system the compiled tables use
  -- and the same one the source PDFs use — no scaling arithmetic anywhere between a measurement and
  -- the paper. On a flow row x and y are unused (the anchor offsets carry position); w and h still
  -- size the box, so they are required on both kinds.
  x numeric(8, 2) not null default 0,
  y numeric(8, 2) not null default 0,
  w numeric(8, 2) not null,
  h numeric(8, 2) not null,
  align text not null default 'right',
  font_size numeric(5, 2) not null default 9,
  -- What the field prints. 'value' reads the employee's record through the same values map every
  -- compiled placement reads, so an added field fills for every employee and stays correct when the
  -- record changes. 'literal' prints a fixed string and must never look like data.
  source_kind text not null,
  value_key text,
  literal_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_hr_id text,
  updated_by_hr_id text,
  constraint hiring_pack_document_fields_document_known check (
    document in (
      'contract', 'form1', 'workerDataForm', 'custodyLaptop', 'custodyMobile',
      'form6', 'resignation', 'mutualTermination', 'clearanceEmployee', 'clearanceCompany'
    )
  ),
  constraint hiring_pack_document_fields_align_known check (align in ('right', 'center', 'left')),
  -- Exactly one placement model per row. See the header.
  constraint hiring_pack_document_fields_placed_once check (
    (page is not null and anchor_selector is null)
    or (page is null and anchor_selector is not null and anchor_dx is not null and anchor_dy is not null)
  ),
  constraint hiring_pack_document_fields_page_positive check (page is null or page >= 1),
  -- A box with no width or height is a field that prints nothing and cannot be clicked to fix.
  constraint hiring_pack_document_fields_box_real check (w > 0 and h > 0 and font_size > 0),
  -- Exactly one source, complete. A row carrying both would print whichever the reader checked
  -- first, and the two callers would disagree.
  constraint hiring_pack_document_fields_source_paired check (
    (source_kind = 'value' and value_key is not null and length(btrim(value_key)) > 0 and literal_text is null)
    or (source_kind = 'literal' and literal_text is not null and value_key is null)
  ),
  -- Hiding is an override's verb. A hidden addition is a row nothing renders and nothing lists.
  constraint hiring_pack_document_fields_hide_is_an_override check (hidden = false or default_key is not null),
  -- An override names a placement; an addition brings its own source. Both are already guaranteed
  -- above; this pins the remaining nonsense — an override that is neither moved nor hidden nor
  -- re-sourced is a row with no effect, and rows with no effect accumulate until nobody trusts the
  -- table. The API refuses to write one; this is the second lock.
  constraint hiring_pack_document_fields_override_or_addition check (
    default_key is null or length(btrim(default_key)) > 0
  ),
  -- Upper-case canonical hr ids, the same rule the rest of this schema follows: employees stores
  -- 'B-10' while other tables have stored 'b-10', and an un-normalised comparison matches nobody.
  constraint hiring_pack_document_fields_employee_hr_id_upper check (
    employee_hr_id is null or employee_hr_id = upper(employee_hr_id)
  ),
  constraint hiring_pack_document_fields_updated_by_upper check (
    updated_by_hr_id is null or updated_by_hr_id = upper(updated_by_hr_id)
  ),
  constraint hiring_pack_document_fields_created_by_upper check (
    created_by_hr_id is null or created_by_hr_id = upper(created_by_hr_id)
  )
);

comment on table public.hiring_pack_document_fields is
  'The hiring pack''s field layer: an OVERLAY on the compiled layout tables in src/lib/hiring-pack/*-layout.ts. A row moves a compiled placement, hides one, or adds a field that was never compiled. Scoped to a template version so an archived document reprints with the layout it was signed under, and so a flow-surface CSS anchor stays valid. employee_hr_id NULL means every employee, which is all the editor writes today. Reset = delete the rows; the compiled tables are the default and the measurement.';

comment on column public.hiring_pack_document_fields.default_key is
  'The compiled placement this row overrides, by key. NULL = the row adds a field no compiled table has. An override naming a key the current template version no longer declares is IGNORED at render time, never promoted to a new field — its coordinates refer to artwork nobody has re-checked.';

comment on column public.hiring_pack_document_fields.anchor_selector is
  'Flow surfaces only (contract, workerDataForm, custody*, clearance*). A CSS path into the rendered document, with anchor_dx/dy as an offset in points. Typeset documents flow across pages, so a page coordinate would drift the moment a longer name moved a page break; an anchored field travels with its clause instead. Stable because a template version''s markup never changes.';

-- The read on every render and every editor open: one document's layout for one version.
create index if not exists hiring_pack_document_fields_document_idx
  on public.hiring_pack_document_fields (document, template_version_id);

-- One override per compiled placement, per document version, per scope. Two would both render, one
-- on top of the other, and which one the operator sees would depend on insertion order.
create unique index if not exists hiring_pack_document_fields_override_unique
  on public.hiring_pack_document_fields (
    document, template_version_id, coalesce(employee_hr_id, ''), default_key
  )
  where default_key is not null;

-- RLS on with no grants to authenticated or anon, matching the rest of this schema. Every read goes
-- through the service-role client behind assertPermission, so a policy-less RLS-enabled table is the
-- correct closed default: a browser must never reach these rows directly, because the layout of a
-- government form is not the browser's to change.
alter table public.hiring_pack_document_fields enable row level security;

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Purely additive. Dropping the table restores the previous shape exactly and returns every document
-- to its compiled layout, which is the same thing the editor's own Reset button does. It DISCARDS
-- every field anyone has added or moved, so read the count first:
--
--   select document, count(*) from public.hiring_pack_document_fields group by 1 order by 1;
--
-- begin;
--   drop table if exists public.hiring_pack_document_fields;
-- commit;

-- The company's own details, editable instead of compiled in.
--
-- WHY. Every HR Forms document prints part of the company's legal identity — the head office address
-- on the contract recital, on Form 1's back-page إقرار and on the Ministry of Labour forms; the
-- commercial register on the clearance instruments; the responsible manager over the signature line.
-- Until now those values existed only in `src/config/system-settings.ts`, so correcting the address
-- on a printed contract meant a code change, a PR and a deploy. The paper editor rendered them
-- locked with the tooltip "this value comes from the company record", which was true and no use to
-- the person holding the wrong paper. Owner, 2026-09-06: it must be editable, all of it.
--
-- ── ONE ROW PER VALUE, NOT ONE WIDE ROW ────────────────────────────────────────────────────────
--
-- A wide row would have to be written whole on every save, and this repository has already paid for
-- "an optional field written unconditionally is a silent erase": one edit carrying a stale copy of
-- the other eighteen values would quietly restore them. A key/value row means a save touches exactly
-- the value that was typed.
--
-- It also makes RESET expressible. Deleting the row means "print the compiled default again", which
-- is a genuinely different answer from an empty string — an empty string is a deliberate blank, and
-- a deliberate blank is a real thing to want: `defaultInsuranceOffice` ships blank so Form 1 prints
-- a visible gap for the clerk rather than a plausible wrong value. A single wide row could not tell
-- those two apart without a sentinel, and a sentinel is a value somebody eventually types by hand.
--
-- ── NO ENUM CHECK ON `detail_key`, DELIBERATELY ────────────────────────────────────────────────
--
-- `hiring_pack_document_fields` pins its `document` column to a known vocabulary because a row
-- naming a document nothing renders is a box that silently never appears and that no screen can find
-- or delete. The failure here is not that shape: `loadCompanyDetailOverrides` filters every row
-- through `isCompanyDetailKey`, and the API route validates the key before writing, so an unknown
-- key is inert and visible in one `select`. Pinning the list in SQL would instead mean a migration —
-- a protected action — every time one more company value becomes editable, which is the direction
-- this feature is expected to grow.
--
-- ── ADDITIVE, AND REVERSIBLE BY DROPPING THE TABLE ─────────────────────────────────────────────
--
-- One new table. No existing row is touched and nothing is dropped. With the table gone, every
-- renderer falls back to the compiled constants, which is exactly what the papers printed before
-- this migration — and `company-details-store.ts` treats a missing table as "no overrides" rather
-- than as an error, so the application keeps printing either way. That matters because production
-- has no PITR: seven daily physical backups are the whole recovery story, at one-day granularity,
-- restoring the WHOLE database.

begin;

create table if not exists public.hiring_pack_company_details (
  -- The storage key from COMPANY_DETAIL_FIELDS in src/lib/hiring-pack/company-details.ts. NOT the
  -- token a paper marks its span with: several tokens print one value (the head office is
  -- COMPANY_HEAD_OFFICE on the contract, companyAddress on Form 1 and companyHeadOffice on the
  -- labour forms), and a row per token would let three papers hold three different addresses for
  -- one company.
  detail_key text primary key,
  -- What prints. NOT NULL because "no value" is expressed by having no row at all; an empty string
  -- here is a deliberate blank and prints as one.
  detail_value text not null,
  updated_at timestamptz not null default now(),
  -- Who typed it, in the stored (upper) form every actor column in this database uses. Deliberately
  -- NOT constrained to upper(): hrIdForStorage falls back to the raw id rather than dropping one it
  -- cannot canonicalise, and a CHECK would turn that fallback into a 500 on the save of a legal
  -- document.
  updated_by_hr_id text,
  constraint hiring_pack_company_details_key_not_blank check (btrim(detail_key) <> '')
);

comment on table public.hiring_pack_company_details is
  'The company''s own legal details as the HR Forms documents print them, one row per value. An OVERRIDE on the compiled defaults in src/config/system-settings.ts: no row means print the compiled value, an empty detail_value means print a blank on purpose. Company-wide by construction — there is no employee column, because an address that differed between two employees'' papers would be a defect in the file. Reset a value by deleting its row.';

comment on column public.hiring_pack_company_details.detail_key is
  'The storage key from COMPANY_DETAIL_FIELDS (src/lib/hiring-pack/company-details.ts), never a document''s own token name. Permanent once written: renaming a key orphans its row, which prints as the value silently reverting to the compiled default.';

comment on column public.hiring_pack_company_details.detail_value is
  'What prints. An empty string is a deliberate blank and is preserved; "print the compiled default" is expressed by deleting the row.';

-- RLS on with no grants to authenticated or anon, matching the rest of this schema. Every read goes
-- through the service-role client behind assertPermission, and the write is additionally gated on
-- Super Admin in the route: the company's registered address on a government form is not the
-- browser's to change.
alter table public.hiring_pack_company_details enable row level security;

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Purely additive. Dropping the table returns every document to the compiled company in
-- system-settings.ts, which is what they printed before this existed and what they print today for
-- any value nobody has edited. It DISCARDS every correction anyone has made, so read them first:
--
--   select detail_key, detail_value, updated_at, updated_by_hr_id
--     from public.hiring_pack_company_details order by detail_key;
--
-- begin;
--   drop table if exists public.hiring_pack_company_details;
-- commit;

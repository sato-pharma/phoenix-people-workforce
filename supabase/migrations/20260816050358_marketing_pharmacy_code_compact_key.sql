-- A zero-padding-tolerant lookup key for the marketing pharmacy code reference database.
--
-- WHY: Customer Validation's vendor-code check compares the typed code to
-- `normalized_pharmacy_code` with exact string equality (resolvePharmacyCodeReference in
-- src/lib/marketing-requests/service.ts). POS — and only POS — exports its customer codes
-- zero-padded to 10 digits, so the reference row for pharmacy 1503246 is stored as
-- '0001503246'. A rep who types the code the way the pharmacy quotes it gets "not in the
-- Phoenix database", and the row is right there.
--
-- Measured on production 2026-08-16:
--     POS         27,612 reference rows — 27,611 zero-padded  (61% of the whole table)
--     Ibn sina    13,249 rows — 0 padded
--     everyone else 2,746 rows — 0 padded
-- So for the largest distributor the check could effectively never return "tracked".
--
-- SAFETY: stripping leading zeros collapses NOTHING inside a distributor. Verified over all
-- 45,414 rows: 0 groups where two distinct stored codes share one zero-stripped key. (35 keys
-- repeat ACROSS distributors, which cannot bite — every lookup is scoped by distributor_id.)
-- If a collision is ever imported, the resolver reports 'ambiguous' rather than guessing,
-- because buildPharmacyCodeReferenceResult already treats >1 match that way.
--
-- Only purely numeric codes are compacted. An alphanumeric code that legitimately begins with
-- '0' keeps its normalized value untouched — the same guard `phx_resolve_marketing_pharmacy_codes`
-- uses for its digit-normalized pass (20260809014712, lines 171-173). An all-zero code compacts
-- to '0' rather than to the empty string.
--
-- The expression is repeated in full rather than referencing `normalized_pharmacy_code`, because
-- Postgres forbids a generated column from reading another generated column. It must stay in step
-- with that column's definition; both are asserted by tests/marketing-pharmacy-code-compact.test.ts.

alter table public.marketing_pharmacy_code_references
  add column if not exists compact_pharmacy_code text
  generated always as (
    case
      when lower(btrim(regexp_replace(coalesce(raw_pharmacy_code, ''), '\s+', ' ', 'g'))) ~ '^[0-9]+$'
        then coalesce(
               nullif(
                 ltrim(lower(btrim(regexp_replace(coalesce(raw_pharmacy_code, ''), '\s+', ' ', 'g'))), '0'),
                 ''
               ),
               '0'
             )
      else lower(btrim(regexp_replace(coalesce(raw_pharmacy_code, ''), '\s+', ' ', 'g')))
    end
  ) stored;

comment on column public.marketing_pharmacy_code_references.compact_pharmacy_code is
  'normalized_pharmacy_code with leading zeros stripped (numeric codes only). Lookup key for the '
  'Customer Validation vendor-code check, so a rep typing 1503246 finds POS row 0001503246.';

-- Mirrors marketing_pharmacy_code_refs_norm_lookup_idx so the compact pass is an index probe, not
-- a scan of the distributor. Both columns are needed: the resolver tries exact first and only
-- falls back to compact, so neither index makes the other redundant.
create index if not exists marketing_pharmacy_code_refs_compact_lookup_idx
  on public.marketing_pharmacy_code_references (distributor_id, compact_pharmacy_code);

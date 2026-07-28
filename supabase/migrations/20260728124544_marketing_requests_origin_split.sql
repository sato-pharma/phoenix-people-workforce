-- Split marketing requests by ORIGIN: imported from Excel vs submitted inside Phoenix.
--
-- WHY (owner decision 2026-07-28): from 2026-08-01 there are no more Excel imports — every
-- marketing request is submitted through Phoenix. Phoenix-submitted requests are materially more
-- accurate than the imported ones, because the in-app path validates as it goes: the Customer
-- Validation UI runs resolvePharmacyCodeReference against the 20,097-row pharmacy code-reference
-- database, while the bulk importer never did.
--
-- The evidence for that accuracy gap, measured on production 2026-07-28:
--   * 286 of 287 pharmacy links sit at reference_status = 'pending' — never validated
--   * a code the reference DB cannot find has no sales 27.9% of the time, vs 1.3% for a matched
--     code (~21x worse)
--   * all 546 approval steps are 'approved' — not one imported request has a live approval chain
--   * 63 of 65 approved requests cannot be judged until their ROI windows close in 2027
--
-- Reporting them together would drag genuine Phoenix performance down with legacy data quality.
-- So the two become separate modules with separate ROI tracking, and this column is the seam.
--
-- VERIFIED BEFORE BACKFILL: every one of the 217 existing rows is an Excel import — all created
-- 2026-06-20 between 13:44 and 13:48 UTC, request_code uniformly 'REQ-*', created_by_hr_id
-- carrying the original requester (plus the synthetic 'B-HIST-MG' for historical-manager rows).
-- There is not a single Phoenix-submitted request in production, so the backfill below is
-- unambiguous and the live ROI tracker correctly starts empty.
--
-- NOT the same thing as status = 'archived'. That is a LIFECYCLE state (81 rows: "this request is
-- finished"). This is PROVENANCE ("this came from Excel"). Two different questions, deliberately
-- two different columns — collapsing them would corrupt both.
--
-- Default is 'phoenix' so anything created from now on is correct without the writer having to
-- remember; the importers additionally stamp 'xlsx_import' explicitly.

alter table public.marketing_requests
  add column if not exists origin text not null default 'phoenix';

-- Backfill every pre-existing row: all of them are Excel imports (verified above).
update public.marketing_requests
   set origin = 'xlsx_import'
 where created_at < timestamptz '2026-08-01 00:00:00+00'
   and origin <> 'xlsx_import';

alter table public.marketing_requests
  drop constraint if exists marketing_requests_origin_check;

alter table public.marketing_requests
  add constraint marketing_requests_origin_check
  check (origin in ('xlsx_import', 'phoenix'));

-- Both ROI surfaces filter on this column, so it is on the hot path for every report query.
create index if not exists marketing_requests_origin_idx
  on public.marketing_requests (origin);

comment on column public.marketing_requests.origin is
  'Provenance: xlsx_import = migrated from the historical Excel sheet (frozen, lower data quality, no live approval chain); phoenix = submitted in-app from 2026-08-01 onward (validated at entry). Drives the split between the Archived Marketing Requests module and the live one. NOT the same as status=''archived'', which is a lifecycle state.';

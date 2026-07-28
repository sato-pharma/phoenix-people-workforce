-- Backfill pharmacy code-reference resolution for links the bulk importer never validated.
--
-- WHY: marketing_pharmacy_distributor_codes has two creation paths, and only one validated.
--   * createMarketingValidationRecord (Customer Validation UI) calls resolvePharmacyCodeReference
--     and stores the real reference_id / reference_match_count / reference_status.
--   * roi-sheet-writer.ts (bulk ROI sheet import) HARDCODED reference_status = 'pending' and never
--     consulted the reference database at all.
--
-- Production came in through the bulk importer, so 286 of 287 links sit at 'pending' with
-- reference_match_count = 0 while marketing_pharmacy_code_references holds 20,097 rows that have
-- effectively never been read. The matcher did not fail — it was never called.
--
-- This matters because the reference state is a strong predictor of a broken pharmacy link.
-- Measured on production 2026-07-28:
--     matched     151 links —   1.3% have no sales at that code
--     not_found   122 links —  27.9% have no sales at that code   (~21x worse)
--     ambiguous    14 links —   0.0%
--
-- Simulating the resolver over the 286 pending links yields: 150 matched, 122 not_found,
-- 14 ambiguous. Those 122 + 14 become a concrete worklist for whoever owns pharmacy mapping.
--
-- SCOPE: this sets the reference_* columns only. It does NOT change attribution — the ROI join
-- still matches on normalized_pharmacy_code exactly as before, and no request's actual/required
-- ROI value moves as a result of this migration. It restores visibility, not numbers.
--
-- Mirrors buildPharmacyCodeReferenceResult() in src/lib/marketing-requests/service.ts:
--     1 match  -> 'matched'   (reference_id set)
--    >1 match  -> 'ambiguous' (reference_id null)
--     0 match  -> 'not_found' (reference_id null)
--
-- Only rows still at 'pending' are touched, so a link a human has already validated through the
-- UI is never overwritten. Idempotent: re-running re-derives the same values from the same
-- reference data.

with resolved as (
  select pdc.id,
         count(ref.id) as match_count,
         min(ref.id)   as first_reference_id
  from public.marketing_pharmacy_distributor_codes pdc
  left join public.marketing_pharmacy_code_references ref
    on ref.distributor_id = pdc.distributor_id
   and ref.normalized_pharmacy_code = pdc.normalized_pharmacy_code
  where pdc.reference_status = 'pending'
  group by pdc.id
)
update public.marketing_pharmacy_distributor_codes pdc
   set reference_match_count = r.match_count,
       reference_id          = case when r.match_count = 1 then r.first_reference_id else null end,
       reference_status      = case
                                 when r.match_count = 1 then 'matched'
                                 when r.match_count > 1 then 'ambiguous'
                                 else 'not_found'
                               end,
       validation_notes      = case
                                 when r.match_count = 1 then null
                                 when r.match_count > 1 then 'Reference ambiguous.'
                                 else 'Reference not found.'
                               end,
       updated_at            = now()
  from resolved r
 where pdc.id = r.id;

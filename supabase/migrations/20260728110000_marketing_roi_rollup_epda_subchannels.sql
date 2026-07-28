-- Add the two live EPDA sub-channel codes to the marketing ROI distributor rollup.
--
-- marketing_roi_distributor_rollup translates a Source-of-Sales distributor_code to the
-- marketing distributor it belongs to, so ROI attribution can see sales made through a
-- distributor's sub-channels. It is a hand-maintained reference table: nothing in the codebase
-- writes to it (only the CREATE TABLE in the 2026-07-11 baseline), so it does not self-heal when
-- Source-of-Sales gains or renames a distributor code.
--
-- WHAT DRIFTED: the original seed (20260621155000_marketing_roi_distributor_rollup.sql) mapped
-- EPDA as ('EP','EP','epda'), ('EP-R','EP','epda'), ('EP-S','EP','epda'). Those two sub-codes no
-- longer exist. Source-of-Sales now uses:
--     EP      "epda"              63 validated sale rows
--     EP-PHS  "EPDA-Pharmacies" 6,961 validated sale rows
--     EP-BK   "EPDA-BULK"         385 validated sale rows
-- EP-R/EP-S were dropped from the rollup at some point but EP-PHS/EP-BK were never added, so only
-- the 63 bare-EP rows have been eligible for marketing ROI attribution.
--
-- Same shape as the EG family already in the table (EG / EG-BR / EG-HOS -> parent EG, "egd").
--
-- MEASURED IMPACT (production, 2026-07-28): 2 marketing requests gain attribution, 13 matching
-- sale rows, ~EGP 34,317. Small, because only 3 requests target EPDA at all. This does NOT
-- materially move the module's 67.7% no-attribution rate -- that is concentrated in "overseas"
-- (97 of 160 requests) and "ibn sina" (48 of 74), both of which are already fully mapped here.
-- The value of this change is correctness plus not silently losing future EPDA campaigns.
--
-- NOT AN OVER-ATTRIBUTION RISK: the rollup only decides which distributor's rows are ELIGIBLE.
-- Attribution still requires an exact normalized customer-code match between the sale row's
-- client_code and the request's target pharmacy code, so a bulk-channel sale can only ever count
-- when it was made to that exact target pharmacy.
--
-- Idempotent; safe to re-run.

insert into public.marketing_roi_distributor_rollup
  (sos_distributor_code, parent_distributor_code, marketing_normalized_name)
values
  ('EP-PHS', 'EP', 'epda'),
  ('EP-BK',  'EP', 'epda')
on conflict (sos_distributor_code) do update
  set parent_distributor_code   = excluded.parent_distributor_code,
      marketing_normalized_name = excluded.marketing_normalized_name;

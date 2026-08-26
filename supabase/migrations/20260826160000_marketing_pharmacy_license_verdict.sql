-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The approver's verdict on the pharmacy trade licence — the MARKETING half.
--
-- 20260825120000 gave both modules the licence itself (رخصة الصيدلية), for the venue that carries
-- no distributor code anywhere and therefore has nothing but the rep's word tying its name to a
-- real business. Only Direct Orders got somewhere to record the answer the licence exists to
-- produce: does the trade name printed on it match the name on the shop sign (اليافطة) in the
-- storefront photo. On a marketing request the approver could see both documents stacked and make
-- the comparison, and nothing anywhere captured whether they had. This closes that half.
--
-- WHY IT LANDS ON marketing_pharmacies AND NOT ON marketing_request_pharmacies.
--
-- The obvious mirror of the direct-order table is the request↔pharmacy link row. It is the wrong
-- home twice over.
--
--   1. IT WOULD BE ERASED. Resubmitting a returned request DELETES every link row for that request
--      and re-inserts it (`resubmitMarketingRequest`, service.ts) — so a verdict recorded there
--      would vanish on an edit nobody associates with the licence, and the field would read "not
--      checked yet" again with no trace that it ever had been. Evidence that a routine edit can
--      silently unmake is worse than no evidence, because the blank is indistinguishable.
--   2. IT IS THE WRONG GRAIN. The licence is filed against the PHARMACY
--      (`marketing_evidence_files.entity_id = pharmacy_id`), not against the request. And the
--      question it answers — is this shop who it says it is — is a fact about the shop. It does
--      not become true or false again because a different request targets the same pharmacy.
--
-- Recorded here it survives resubmission, and one answer serves every later request against the
-- same venue. It sits deliberately beside the validation_status / validated_by_hr_id /
-- validated_at block already on this table: same kind of fact, same shape, same audit expectations.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.marketing_pharmacies
  -- THREE-VALUED ON PURPOSE, exactly like the direct-order column. NULL means NOBODY WAS ASKED —
  -- no licence on file, or a pharmacy last looked at before this shipped — and must never be
  -- rendered as "checked and fine". A false is a real finding; a null is the absence of one, and
  -- the screens are required to say "Not checked yet" out loud rather than leaving the row blank.
  add column if not exists license_name_matches_sign boolean,
  -- Who answered and when. The direct-order verdict inherits its author from the decision row it
  -- is written onto (`decided_by_hr_id` / `decided_at`); this one has no such row behind it — it
  -- is recorded against the pharmacy, at a moment of its own — so it carries its own author.
  add column if not exists license_name_checked_by_hr_id text,
  add column if not exists license_name_checked_at timestamptz;

comment on column public.marketing_pharmacies.license_name_matches_sign is
  'Approver''s verdict that the trade name on the pharmacy licence matches the shop sign. NULL = never asked.';
comment on column public.marketing_pharmacies.license_name_checked_by_hr_id is
  'HR id of the approver who compared the licence against the sign. NULL whenever the verdict is NULL.';
comment on column public.marketing_pharmacies.license_name_checked_at is
  'When the comparison was recorded. NULL whenever the verdict is NULL.';

-- An answer must carry its author and its moment, or it is an assertion nobody owns — and clearing
-- a mis-click must clear all three together rather than stranding a name beside an empty verdict.
--
-- The direct-order table can additionally refuse a verdict about a licence that is NOT ON FILE,
-- because `license_storage_path` sits on that very row. Here the licence lives in
-- marketing_evidence_files, so that half cannot be expressed as a CHECK at all; it is enforced in
-- `recordMarketingPharmacyLicenseVerdict`, and pinned by a test, precisely because the database
-- cannot be the one to catch it.
alter table public.marketing_pharmacies
  drop constraint if exists marketing_pharmacies_license_verdict_check;
alter table public.marketing_pharmacies
  add constraint marketing_pharmacies_license_verdict_check
  check (
    (
      license_name_matches_sign is null
      and license_name_checked_by_hr_id is null
      and license_name_checked_at is null
    )
    or (
      license_name_matches_sign is not null
      and license_name_checked_by_hr_id is not null
      and license_name_checked_at is not null
    )
  );

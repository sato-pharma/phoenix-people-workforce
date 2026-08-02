-- Source-of-Sales learns the Upper Egypt 1 / Upper Egypt 2 split, so a Direct sheet can tag it.
--
-- Owner ruling 2026-08-02: "tag UE-1 and UE-2 in the direct sheet".
--
-- Why this is needed before the sheet can carry those codes: Anti Infective operationally splits
-- Upper Egypt into two DM territories, and the ORG model already knows them —
--
--     au_v_regions:               AB CA D1 D2 GZ OT UE  UE-1 "Upper Egypt 1"  UE-2 "Upper Egypt 2"
--     source_of_sales_regions:    AB CA D1 D2 GZ OT UE   <-- the split is absent
--
-- so a Direct row tagged "UE-1" today resolves against no Source-of-Sales region. That mismatch is
-- already documented in src/lib/sales/territory/skeleton.ts, which reaches for au_v_regions
-- precisely because the SoS table cannot name these two.
--
-- The consequence it fixes: au.f_monthly_attribution emits Direct with the SHEET's region code,
-- and au.f_monthly_achievement resolves a DM from it. With a single "UE" on the sheet, Anti
-- Infective's Upper Egypt Direct is ambiguous between UE-1 (Nosiba Salah) and UE-2 (Ahmed
-- Nashaat), so it resolves to NO DM — 3,110 units / 208,652.40 EGP across the 7 loaded periods,
-- the only unresolved (line, region) pair in the whole dataset.
--
-- Names and codes are copied from au_v_regions verbatim so the two masters cannot drift apart;
-- the organogram stays the source of truth for org structure (owner's standing rule).
--
-- SCOPE — this migration is additive reference data ONLY:
--   * It does NOT move any area. Every UE1..UE8 area stays under "UE"; only the seat model splits
--     them, exactly as before.
--   * It does NOT re-tag a single existing sales row. The 6 historical periods still carry "UE"
--     and remain DM-less until the owner decides whether to re-tag them — a separate, explicit
--     data decision, never a side effect of adding a lookup row.
--   * ims_ratio is left NULL. It is an owner-entered figure per region and must not be invented;
--     "Others" is likewise one indivisible bucket (see src/lib/sales/ims-ratio.ts).

begin;

insert into public.source_of_sales_regions
  (region_code, region_name, normalized_region_name, description, active, source_file, source_sheet)
select
  r.region_code,
  r.region_name,
  lower(btrim(r.region_name)),
  'Operational DM territory split for Upper Egypt; mirrors au_v_regions.',
  true,
  'organogram/au_v_regions',
  'au_v_regions'
from (values
  ('UE-1', 'Upper Egypt 1'),
  ('UE-2', 'Upper Egypt 2')
) as r(region_code, region_name)
on conflict (region_code) do nothing;

commit;

-- Add IMS (market-share) ratio storage to the Source-of-Sales geography master.
--
-- The owner maintains an IMS ratio per sales area in a spreadsheet; until now there was nowhere to
-- store it (verified 2026-07-27: no ims/ratio/weight/share/potential column existed anywhere in the
-- public, au or analytics schemas — au.monthly_targets holds absolute target_units/target_value, not
-- percentages). This adds one nullable column to each of the two geography master tables.
--
-- STORED AS A FRACTION, NOT A PERCENT: 0.0341 means 3.41%. This matches the app-wide convention in
-- src/lib/sales/format.ts, whose formatPercent() defaults to input:"ratio" and multiplies by 100.
-- The CHECK constraints enforce the 0..1 domain, so a stray whole-number percent (3.41) is rejected
-- at write time rather than silently stored and later rendered as 341%.
--
-- `numeric` is deliberately left unconstrained (no precision/scale): it is exact decimal, so the
-- 39 area ratios sum to exactly 0.9503 with no floating-point drift, which is what the drift guard
-- in tests/sales-ims-ratio.test.ts asserts.
--
-- THE OTHERS RULE (owner decision, 2026-07-27): the residual 4.97% belongs to the OT ("Others")
-- region AS A WHOLE and must NEVER be split across its individual areas. It is therefore stored
-- ONCE on the OT row of source_of_sales_regions, and every OT *area* keeps ims_ratio NULL.
--
-- This is what makes the region-level choice pay off: OT's area list is volatile. It expanded from
-- 3 areas to 9 (OT1, OT2, OT4-OT10, with OT3 retired to "Aswan (Legacy)") midway through authoring
-- this migration. Because the figure is region-level, that reshuffle needed no change here — a
-- per-area split would have had to be re-derived. The 39 non-OT areas were unaffected by it and
-- were re-verified against production afterwards: none missing, deactivated, or moved into OT.
--
-- Additive + idempotent: nullable columns, guarded constraints, and value loads that no-op when the
-- stored value already matches.

-- ---------------------------------------------------------------------------
-- 1. Area-level ratio
-- ---------------------------------------------------------------------------

alter table public.source_of_sales_areas
  add column if not exists ims_ratio numeric;

comment on column public.source_of_sales_areas.ims_ratio is
  'IMS (market share) ratio for this area, stored as a FRACTION of total national market: 0.0341 = 3.41%. NULL where unknown, and ALWAYS NULL for areas in the OT ("Others") region — the Others share is held once at region level on source_of_sales_regions.ims_ratio and must never be split per area. The 39 non-OT areas sum to exactly 0.9503.';

alter table public.source_of_sales_areas
  drop constraint if exists source_of_sales_areas_ims_ratio_range;

alter table public.source_of_sales_areas
  add constraint source_of_sales_areas_ims_ratio_range
  check (ims_ratio is null or (ims_ratio >= 0 and ims_ratio <= 1));

-- Owner's authoritative IMS ratios (2026-07-27). Percent values divided by 100 to store as
-- fractions. All 39 codes were verified against production to resolve 1:1 with no duplicates and
-- no gaps: they cover exactly the 39 active non-OT areas.
update public.source_of_sales_areas a
set ims_ratio = v.ratio,
    updated_at = now()
from (values
  ('UE8', 0.0067), ('UE3', 0.0104), ('UE1', 0.0112), ('GZ7', 0.0112), ('D17', 0.0122),
  ('UE5', 0.0123), ('UE7', 0.0144), ('UE2', 0.0146), ('GZ1', 0.0149), ('D13', 0.0162),
  ('UE4', 0.0183), ('D23', 0.0184), ('GZ3', 0.0203), ('D16', 0.0203), ('D25', 0.0204),
  ('UE6', 0.0204), ('D12', 0.0207), ('CA4', 0.0212), ('AB2', 0.0229), ('CA3', 0.0241),
  ('GZ6', 0.0258), ('D14', 0.0263), ('D11', 0.0269), ('D22', 0.0272), ('D15', 0.0275),
  ('CA5', 0.0276), ('AB3', 0.0285), ('CA6', 0.0291), ('D21', 0.0291), ('D26', 0.0296),
  ('GZ5', 0.0316), ('AB5', 0.0322), ('AB4', 0.0329), ('AB1', 0.0341), ('CA2', 0.0352),
  ('D24', 0.0405), ('GZ2', 0.0431), ('CA1', 0.0446), ('GZ4', 0.0474)
) as v(area_code, ratio)
where a.area_code = v.area_code
  and a.ims_ratio is distinct from v.ratio;

-- ---------------------------------------------------------------------------
-- 2. Region-level ratio (holds the indivisible "Others" share)
-- ---------------------------------------------------------------------------

alter table public.source_of_sales_regions
  add column if not exists ims_ratio numeric;

comment on column public.source_of_sales_regions.ims_ratio is
  'Region-level IMS ratio, stored as a FRACTION (0.0497 = 4.97%). Populated ONLY for regions whose share is tracked as one indivisible block rather than per area — today that is OT ("Others") alone. All other regions are NULL and their share is the sum of their areas'' source_of_sales_areas.ims_ratio. Invariant: sum(non-OT area ratios) + OT region ratio = 1.';

alter table public.source_of_sales_regions
  drop constraint if exists source_of_sales_regions_ims_ratio_range;

alter table public.source_of_sales_regions
  add constraint source_of_sales_regions_ims_ratio_range
  check (ims_ratio is null or (ims_ratio >= 0 and ims_ratio <= 1));

-- The residual: 1 - 0.9503 = 0.0497.
update public.source_of_sales_regions
set ims_ratio = 0.0497,
    updated_at = now()
where region_code = 'OT'
  and ims_ratio is distinct from 0.0497;

-- ---------------------------------------------------------------------------
-- 3. Post-load assertions — fail the migration rather than ship a silent drift
-- ---------------------------------------------------------------------------

do $$
declare
  area_total numeric;
  others_total numeric;
  ot_areas_with_ratio integer;
begin
  select coalesce(sum(ims_ratio), 0) into area_total
  from public.source_of_sales_areas
  where region_code <> 'OT' and active;

  select coalesce(ims_ratio, 0) into others_total
  from public.source_of_sales_regions
  where region_code = 'OT';

  select count(*) into ot_areas_with_ratio
  from public.source_of_sales_areas
  where region_code = 'OT' and ims_ratio is not null;

  if area_total <> 0.9503 then
    raise exception 'IMS ratio load failed: active non-OT areas sum to %, expected 0.9503', area_total;
  end if;

  if others_total <> 0.0497 then
    raise exception 'IMS ratio load failed: OT region ratio is %, expected 0.0497', others_total;
  end if;

  if ot_areas_with_ratio <> 0 then
    raise exception 'IMS ratio load failed: % OT area(s) carry a per-area ratio; the Others share must stay at region level', ot_areas_with_ratio;
  end if;

  if area_total + others_total <> 1 then
    raise exception 'IMS ratio load failed: total is %, expected exactly 1', area_total + others_total;
  end if;
end $$;

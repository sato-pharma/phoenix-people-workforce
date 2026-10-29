-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Carvibradine 6.25/5 mg film-coated tablet, the module's FOURTH product.
--
-- WHAT THIS CHANGES: adds Hochster as a fourth factory store, the Carvibradine product, eleven new
-- materials, the eighteen-row material list and the fourteen composition lines. Every
-- insert is `on conflict do nothing`, so nothing that already exists is touched.
--
-- WHY: owner, 2026-10-29, sending Hochster's two papers — the bill of materials
-- (`BOM for Crvibradine 6.25-5 mg.xlsx`) and the composition certificate
-- (`Carvibradine 5mg T COC.pdf`, application 15352) — with one sentence of supply split:
-- **"In Carvibradine T we supply Carvidilol, Ivabradine, Pumphlet, Boxes & aluminium Foil"**.
--
-- Toll-manufactured by Hochster Pharmaceutical Industries for Sato Pharma (the certificate names
-- Sato Pharma as applicant and Hochster as "Manufacturer of FPP"). Hochster's product code is
-- FT11113600, section Solid 2, shelf life 2 years. One batch is a FIXED 30.6 kg = 170,000 tablets of
-- 180 mg (175 mg of core plus 5 mg of coat).
--
-- ── Why the geometry is in MILLIGRAMS ───────────────────────────────────────────────────────────
--
-- The same reason as Royanoxicam: the geometry columns are integers and 180 mg is not a whole gram.
-- 30,600,000 mg divided by 180 mg is exactly 170,000 — the BOM's own "Batch Size: 170000 Tablet" —
-- so `run_volume_ml % dose_ml = 0` holds and nothing is left over. The large label is the kilogram,
-- so the batch tile reads the BOM's own 30.6 kg.
--
-- ── Who brings what ─────────────────────────────────────────────────────────────────────────────
--
-- Sato: carvedilol, ivabradine hydrochloride, the leaflet, the box and the aluminium blister foil.
-- Hochster: the ten excipients and the three Q.S solvents. Only Sato lines can reach a buy list; the
-- Hochster lines carry their real quantities because the screen still shows what a run consumes.
--
-- ── Seven materials are SHARED with Royanoxicam, and are deliberately not re-inserted ───────────
--
-- Aerosil 200, croscarmellose sodium, magnesium stearate, PEG 6000, titanium dioxide, purified water
-- and ethyl alcohol are the same pharmacopoeial materials Royanoxicam already lists, so Carvibradine
-- links the EXISTING rows (the citric-acid and lemon-flavour precedent between the syrup and the
-- powder). Stock held at a factory is read from each product's OWN factory store
-- (`factoryLocationIdFor`), so Aerosil counted at Egyphar never reads as held at Hochster, and the
-- expiry sweep de-duplicates a shared lot on material/location/expiry.
--
-- Three look shared and are NOT: the lactose (Royanoxicam's is the 200-mesh grade; Hochster's papers
-- name no grade), the hypromellose (Royanoxicam's is E15, Hochster's is E5) and the ethanol in the
-- CORE (absolute ethanol, a different grade from the 96% ethyl alcohol in the coat). Each is its own
-- material, because merging two grades would let one product's stock count for the other's.
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- It seeds NO stock anywhere: nobody has reported a count, and an absent row says "never counted".
--
-- It gives the ALUMINIUM BLISTER FOIL no composition row. The BOM is a bulk-tablet BOM and names no
-- packaging, so how many kilograms of foil a box takes is recorded nowhere — the same deliberate
-- absence Royanoxicam's foil shipped with. It is entered from the Settings tab's composition editor.
--
-- The absolute ethanol, the ethyl alcohol and the purified water get no composition row either: the
-- certificate says Q.S and that they evaporate during drying and coating.
--
-- `overage_pct` is NULL on every line, so each inherits the module's own default.
--
-- ROLLBACK: this migration is additive.
--   delete from public.prodplan_products where code = 'CARVIBRADINE';  -- cascades its compositions and product_materials
--   delete from public.prodplan_materials where code in ('CARVEDILOL', 'IVABRADINE_HCL', 'LACTOSE_MONO',
--     'MALTODEXTRIN', 'MCC_PH102', 'PREGELATINIZED_STARCH', 'ABSOLUTE_ETHANOL', 'HPMC_E5',
--     'BLISTER_ALU_CARVIBRADINE', 'BOX_CARVIBRADINE', 'LEAFLET_CARVIBRADINE');
--   delete from public.prodplan_locations where code = 'HOCHSTER';
-- The seven shared materials are never deleted by a rollback: Royanoxicam still lists them.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- 🔴 BOX SIZE PENDING. Neither paper says how many tablets go in one box, and the owner could not
-- say on 2026-10-29 either — the person who knows was asleep. `units_per_box` is not editable from
-- the Settings tab, so a guessed figure would sit on the screen as a measured one until a second
-- migration replaced it. This block refuses the whole migration until the real number is written
-- into `units_per_box` below and this block is deleted.
do $$
begin
  raise exception 'Carvibradine: the number of tablets in one box is not known yet (owner, 2026-10-29). Write it into units_per_box and delete this block before applying.';
end
$$;

-- ── 1. Hochster, the fourth toll manufacturer ───────────────────────────────────────────────────
insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values ('HOCHSTER', 'مخزن المصنع — هوكستر', 'At the factory (Hochster)', true, 50)
on conflict (code) do nothing;

-- ── 2. Carvibradine 6.25/5 mg ───────────────────────────────────────────────────────────────────
-- `default_sample_units` is 0: no free-sample count has been named for this product, so the
-- Samples field starts empty rather than at the column's 10,000 default.
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box,
  default_sample_units, notes
)
values (
  'CARVIBRADINE',
  'كارفيبرادين 6.25/5 مجم',
  'Carvibradine 6.25/5 mg',
  'Hochster Pharmaceutical Industries',
  'mg',
  30600000, 180, 180, 180, true, null,
  0,
  'Film-coated tablet — carvedilol 6.25 mg and ivabradine 5 mg (as hydrochloride) — toll-manufactured by Hochster Pharmaceutical Industries for Sato Pharma. One batch is a FIXED 30.6 kg = 170,000 tablets of 180 mg (175 mg core, 5 mg coat). Shelf life 2 years. Hochster product code FT11113600, section Solid 2; composition certificate application 15352. A tablet IS the dose and IS the saleable unit. Sato supplies the two actives, the leaflet, the box and the aluminium foil; Hochster the rest. Seeded 2026-10-29 from Hochster''s bill of materials and the composition certificate.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'HOCHSTER'
  and p.code = 'CARVIBRADINE'
  and p.factory_location_id is null;

-- ── 3. The eleven NEW materials ─────────────────────────────────────────────────────────────────
-- The codes in the notes are off Hochster's BOM, kept because the factory's paperwork names a
-- material by them and ours does not.
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('CARVEDILOL', 'كارفيديلول', 'Carvedilol', 'mass', 'g', 'kg', 1000, false, null, 610,
   'Active ingredient, 6.25 mg a Carvibradine tablet. Sato supplies it. Whether it is imported, and its lead time, are not recorded yet — both are a Settings edit. BOM code STR1111001.'),
  ('IVABRADINE_HCL', 'إيفابرادين هيدروكلوريد', 'Ivabradine hydrochloride', 'mass', 'g', 'kg', 1000, false, null, 620,
   'Active ingredient, 5.39 mg a Carvibradine tablet, equivalent to 5 mg of ivabradine. Sato supplies it. Whether it is imported, and its lead time, are not recorded yet — both are a Settings edit. BOM code STR1111002.'),
  ('LACTOSE_MONO', 'لاكتوز مونوهيدرات', 'Lactose monohydrate', 'mass', 'g', 'kg', 1000, false, null, 630,
   'Filler, and the largest single quantity in a Carvibradine tablet. Hochster''s papers name no mesh grade, so it is NOT Royanoxicam''s 200-mesh lactose. BOM code STR1121001.'),
  ('MALTODEXTRIN', 'مالتودكسترين', 'Maltodextrin', 'mass', 'g', 'kg', 1000, false, null, 640,
   'Binder. BOM code STR1121002.'),
  ('MCC_PH102', 'سليلوز دقيق التبلور (PH 102)', 'Microcrystalline cellulose (PH 102)', 'mass', 'g', 'kg', 1000, false, null, 650,
   'Filler. BOM code STR1121003.'),
  ('PREGELATINIZED_STARCH', 'نشا مُجلتن مسبقًا', 'Pregelatinized starch', 'mass', 'g', 'kg', 1000, false, null, 660,
   'Disintegrant. BOM code STR1121004.'),
  ('ABSOLUTE_ETHANOL', 'إيثانول مطلق', 'Absolute ethanol', 'mass', 'g', 'kg', 1000, false, null, 670,
   'Granulating agent in the core. NO composition row on purpose: the certificate says Q.S and it evaporates during drying. A different grade from the 96% ethyl alcohol in the coat. BOM code STR1124001.'),
  ('HPMC_E5', 'هايبروميلوز E5 (هيدروكسي بروبيل ميثيل سليلوز)', 'Hypromellose (HPMC E5)', 'mass', 'g', 'kg', 1000, false, null, 680,
   'The film coat itself (E464). NOT Royanoxicam''s E15 grade. BOM code STR1121008.'),
  ('BLISTER_ALU_CARVIBRADINE', 'فويل ألومنيوم للشريط — كارفيبرادين', 'Aluminium blister foil — Carvibradine', 'mass', 'g', 'kg', 1000, false, null, 690,
   'Sato supplies it. Bought by the kilogram. NO composition row yet: the BOM is a bulk-tablet BOM and names no packaging, so how much foil a box takes is recorded nowhere. Until that figure is entered in the Settings tab the foil has stock and a price but no requirement, and it never reaches the buy list. Packaging does not expire.'),
  ('BOX_CARVIBRADINE', 'علبة كارفيبرادين', 'Box — Carvibradine', 'count', 'piece', 'piece', 1, false, null, 700,
   'Carvibradine''s own box. Sato supplies it. Holds the product''s units_per_box tablets. Not interchangeable with any other product''s artwork, so it is its own material.'),
  ('LEAFLET_CARVIBRADINE', 'البروشور الداخلي — كارفيبرادين', 'Leaflet — Carvibradine', 'count', 'piece', 'piece', 1, false, null, 710,
   'Carvibradine''s own leaflet. Sato supplies it. One per box, the same basis the box itself carries.')
on conflict (code) do nothing;

-- ── 4. Carvibradine's material list, in the order the certificate numbers them ──────────────────
insert into public.prodplan_product_materials (product_id, material_id, sort_order)
select p.id, m.id, v.sort_order
from public.prodplan_products p
join (values
  ('CARVEDILOL', 10),
  ('IVABRADINE_HCL', 20),
  ('LACTOSE_MONO', 30),
  ('MALTODEXTRIN', 40),
  ('MCC_PH102', 50),
  ('PREGELATINIZED_STARCH', 60),
  ('CROSCARMELLOSE_NA', 70),
  ('AEROSIL_200', 80),
  ('MAGNESIUM_STEARATE', 90),
  ('ABSOLUTE_ETHANOL', 100),
  ('HPMC_E5', 110),
  ('TITANIUM_DIOXIDE', 120),
  ('PEG_6000', 130),
  ('ETHYL_ALCOHOL', 140),
  ('PURIFIED_WATER', 150),
  ('BLISTER_ALU_CARVIBRADINE', 160),
  ('BOX_CARVIBRADINE', 170),
  ('LEAFLET_CARVIBRADINE', 180)
) as v(code, sort_order) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'CARVIBRADINE'
on conflict (product_id, material_id) do nothing;

-- ── 5. The composition certificate, per 180 mg tablet ───────────────────────────────────────────
-- Converted from milligrams per tablet to GRAMS per dose, the base unit these materials count in.
--
-- 🔴 The twelve quantified lines add to exactly 0.180000 g — 175 mg of core plus 5 mg of coat, the
-- certificate's "Total weight of coated tablet". Multiplied by the 170,000 tablets in one batch they
-- reproduce the BOM's "QTY/BATCH (Kg)" column to the digit: carvedilol 1.0625, ivabradine 0.9163,
-- lactose 11.56, maltodextrin 1.8887, cellulose 9.86, starch 2.975, croscarmellose 0.8925, Aerosil
-- 0.2975, magnesium stearate 0.2975, hypromellose 0.595, titanium dioxide 0.119, PEG 0.136 — and
-- 30.6 kg in total.
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-10-29', v.note
from public.prodplan_products p
join (values
  ('CARVEDILOL',             'per_dose', 0.006250, 'sato',    '6.25 mg per tablet — active'),
  ('IVABRADINE_HCL',         'per_dose', 0.005390, 'sato',    '5.39 mg per tablet — active, equivalent to 5 mg ivabradine'),
  ('LACTOSE_MONO',           'per_dose', 0.068000, 'factory', '68 mg per tablet'),
  ('MALTODEXTRIN',           'per_dose', 0.011110, 'factory', '11.11 mg per tablet'),
  ('MCC_PH102',              'per_dose', 0.058000, 'factory', '58 mg per tablet'),
  ('PREGELATINIZED_STARCH',  'per_dose', 0.017500, 'factory', '17.5 mg per tablet'),
  ('CROSCARMELLOSE_NA',      'per_dose', 0.005250, 'factory', '5.25 mg per tablet'),
  ('AEROSIL_200',            'per_dose', 0.001750, 'factory', '1.75 mg per tablet'),
  ('MAGNESIUM_STEARATE',     'per_dose', 0.001750, 'factory', '1.75 mg per tablet'),
  ('HPMC_E5',                'per_dose', 0.003500, 'factory', '3.5 mg per tablet — coat'),
  ('TITANIUM_DIOXIDE',       'per_dose', 0.000700, 'factory', '0.7 mg per tablet — coat'),
  ('PEG_6000',               'per_dose', 0.000800, 'factory', '0.8 mg per tablet — coat'),
  ('BOX_CARVIBRADINE',       'per_box',  1.000000, 'sato',    'One box per box of tablets'),
  ('LEAFLET_CARVIBRADINE',   'per_box',  1.000000, 'sato',    'One leaflet per box')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'CARVIBRADINE'
on conflict (product_id, material_id, effective_from) do nothing;

commit;

-- Timestamp 20261029030057 was minted to sort after every migration already on main.

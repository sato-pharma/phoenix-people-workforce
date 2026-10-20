-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royanoxicam 8 mg film-coated tablet, the module's THIRD product.
--
-- Owner, 2026-10-20, sending Medizen's own two papers: the bill of materials
-- (`Royanoxicam 8 mg BOM.xlsx`) for the run volume and the requirements, and the proposed
-- declaration of composition (`Proposed COC Royafloxacin 5000 & Royanoxicam 8 mg.pdf`, page 1 —
-- "بيان تركيب رويانوكسيكام فقط", Royanoxicam ONLY; page 2 is Royafloxacin 500 mg and is deliberately
-- not seeded here). His own words for the geometry: **"batch size is 31 kg"**.
--
-- Toll-manufactured by Medizen Pharmaceutical Industries, Borg El Arab, for Sato Pharma. One batch
-- is a FIXED 31 kg = 200,000 tablets of 155 mg, 20 tablets to a box, so a run is exactly 10,000
-- boxes with nothing left over.
--
-- ── Why the geometry is in MILLIGRAMS ───────────────────────────────────────────────────────────
--
-- `dose_ml` is an `integer` and the table carries `run_volume_ml % dose_ml = 0`. A coated tablet
-- weighs 155 mg, which is 0.155 g — not a whole gram, so a gram geometry simply will not insert.
-- In milligrams the batch is 31,000,000 and the dose 155, dividing to exactly 200,000 tablets. The
-- LARGE label stays the kilogram, so the tile and the Excel sheet read the owner's own 31 kg; the
-- divisor that gets it there is `MEASURE_UNITS_PER_LARGE` in `src/lib/production-planning/rules.ts`
-- and is 1,000,000 for `mg`, not the 1,000 that was a literal until this change.
--
-- ── Who brings what (owner, 2026-10-20, asked as a multiple choice) ─────────────────────────────
--
-- *"loranoxiam and pamphlet and box and almunium are me others medizen"* — so Sato supplies the
-- active, the leaflet, the box and the aluminium blister foil, and Medizen brings the eleven
-- excipients and the two Q.S solvents. Only the four Sato lines can ever reach a buy list; the
-- Medizen ones are seeded with their real quantities because the screen still has to show what a
-- run consumes, and `balanceAfter` deliberately does not reduce a material Sato does not supply.
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- It seeds NO stock, at Medizen or at Sato's own store: nobody has reported a count for this
-- product, and an absent row says "never counted" where a zero would say "counted, and none".
--
-- It gives the ALUMINIUM BLISTER FOIL no composition row. The BOM is a bulk-tablet BOM and names no
-- packaging at all, so how many kilograms of foil a box of 20 takes is not recorded anywhere — the
-- same deliberate absence `SACHET_FILM_ALU` shipped with on 2026-10-08, and it is the ONE input
-- Royanoxicam is missing. It is entered from the Settings tab's composition editor, never by a
-- second migration guessing a figure.
--
-- Purified water and ethyl alcohol are seeded as MATERIALS with no composition row either, because
-- the composition statement itself says Q.S and "evaporates during processing": there is no
-- per-tablet quantity to hold, and inventing one would put it on a screen that reads as measured.
--
-- `overage_pct` is left NULL on every line, so each inherits the module's own default. Guamusin's
-- explicit zero was a Guamusin decision (the owner asked for its waste left empty until a real run
-- measured one) and must not become every product's.
--
-- Reverting: this migration is additive.
--   delete from public.prodplan_products where code = 'ROYANOXICAM';  -- cascades its compositions and product_materials
--   delete from public.prodplan_materials where code in ('LORNOXICAM', …);
--   delete from public.prodplan_locations where code = 'MEDIZEN';
-- and the measure_unit CHECK can be narrowed back to ml and g once no row holds 'mg'.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. A third measure unit ─────────────────────────────────────────────────────────────────────
-- 🔴 The reader coerces an unrecognised measure unit to 'ml' FAIL-SAFE, so a row holding 'mg' in
-- front of a deploy that does not know the unit yet is mislabelled rather than broken — but it is
-- mislabelled, and the run tile then reads 31,000 L. This migration therefore belongs with its
-- code, not ahead of it.

alter table public.prodplan_products
  drop constraint if exists prodplan_products_measure_unit_check;

alter table public.prodplan_products
  add constraint prodplan_products_measure_unit_check
  check (measure_unit = any (array['ml'::text, 'g'::text, 'mg'::text]));

comment on column public.prodplan_products.measure_unit is
  'The unit the four geometry columns are counted in: ml for a liquid, g for a powder, mg for a tablet (155 mg is not a whole gram and the columns are integers). The arithmetic is unit-agnostic — only the words on the screen and in the Excel sheet change, and mg is still READ in kilograms.';

-- ── 2. Medizen, the third toll manufacturer ─────────────────────────────────────────────────────
insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values ('MEDIZEN', 'مخزن المصنع — ميديزن', 'At the factory (Medizen)', true, 40)
on conflict (code) do nothing;

-- ── 3. Royanoxicam 8 mg ─────────────────────────────────────────────────────────────────────────
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box, notes
)
values (
  'ROYANOXICAM',
  'رويانوكسيكام 8 مجم',
  'Royanoxicam 8 mg',
  'Medizen Pharmaceutical Industries',
  'mg',
  31000000, 155, 155, 155, true, 20,
  'Film-coated tablet, toll-manufactured by Medizen for Sato Pharma. One batch is a FIXED 31 kg = 200,000 tablets of 155 mg; 20 tablets to a box, so one run is exactly 10,000 boxes. Shelf life 3 years. A tablet IS the dose and IS the saleable unit; no free samples, so sample_unit_ml is the tablet itself and is never used. Seeded 2026-10-20 from Medizen''s BOM and its proposed declaration of composition.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'MEDIZEN'
  and p.code = 'ROYANOXICAM'
  and p.factory_location_id is null;

-- ── 4. The sixteen materials ────────────────────────────────────────────────────────────────────
-- None of these already exists: Royanoxicam shares no material with the syrup or the powder. The
-- codes in the notes are MEDIZEN'S OWN, off the BOM, kept because the factory's paperwork names a
-- material by them and ours does not.
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('LORNOXICAM', 'لورنوكسيكام', 'Lornoxicam', 'mass', 'g', 'kg', 1000, false, null, 410,
   'The active ingredient, 8 mg a tablet. Sato supplies it, so it is the one raw material on the buy list. Whether it is imported, and its lead time, are not recorded yet — both are a Settings edit, not a migration.'),
  ('AEROSIL_200', 'ثاني أكسيد السيليكون الغروي (إيروسيل 200)', 'Colloidal silicon dioxide (Aerosil 200)', 'mass', 'g', 'kg', 1000, false, null, 420,
   'Glidant. Medizen code STR1121006.'),
  ('LACTOSE_MONO_200', 'لاكتوز مونوهيدرات 200 مِش', 'Lactose monohydrate 200 mesh', 'mass', 'g', 'kg', 1000, false, null, 430,
   'Filler, and the largest single quantity in the tablet. Medizen code STR1121001.'),
  ('PVP_K30', 'بوفيدون K30', 'Povidone K30 (PVP K30)', 'mass', 'g', 'kg', 1000, false, null, 440,
   'Binder.'),
  ('CROSCARMELLOSE_NA', 'كروس كارميلوز الصوديوم', 'Croscarmellose sodium', 'mass', 'g', 'kg', 1000, false, null, 450,
   'Disintegrant. Medizen code STR1121005.'),
  ('MAIZE_STARCH', 'نشا الذرة', 'Maize starch (corn starch)', 'mass', 'g', 'kg', 1000, false, null, 460,
   'Filler.'),
  ('MAGNESIUM_STEARATE', 'ستيرات المغنيسيوم', 'Magnesium stearate', 'mass', 'g', 'kg', 1000, false, null, 470,
   'Lubricant. Medizen code STR1121007.'),
  ('PURIFIED_WATER', 'ماء منقّى', 'Purified water', 'mass', 'g', 'kg', 1000, false, null, 480,
   'Solvent, in the core and again in the coat. NO composition row on purpose: the declaration says Q.S and the water evaporates during processing, so there is no per-tablet quantity to hold and none can ever reach a purchase order.'),
  ('HPMC_E15', 'ميثوسيل E15 (هيدروكسي بروبيل ميثيل سليلوز)', 'Methocel E15 (hypromellose, HPMC E15)', 'mass', 'g', 'kg', 1000, false, null, 490,
   'The film coat itself.'),
  ('PEG_6000', 'بولي إيثيلين جلايكول 6000', 'Polyethylene glycol 6000 (PEG 6000)', 'mass', 'g', 'kg', 1000, false, null, 500,
   'Plasticizer in the coat. Medizen code STR1121010.'),
  ('TITANIUM_DIOXIDE', 'ثاني أكسيد التيتانيوم', 'Titanium dioxide (C.I. 77891)', 'mass', 'g', 'kg', 1000, false, null, 510,
   'Opacifier in the coat. Medizen code STR1121009.'),
  ('TALC_PURIFIED', 'مسحوق التلك المنقّى', 'Purified talc powder', 'mass', 'g', 'kg', 1000, false, null, 520,
   'Glidant in the coat.'),
  ('ETHYL_ALCOHOL', 'كحول إيثيلي', 'Ethyl alcohol', 'mass', 'g', 'kg', 1000, false, null, 530,
   'Coating solvent. NO composition row on purpose — Q.S, and it evaporates during processing. Medizen code STR1124002.'),
  ('BLISTER_ALU_ROYANOXICAM', 'فويل ألومنيوم للشريط', 'Aluminium blister foil', 'mass', 'g', 'kg', 1000, false, null, 540,
   'Sato supplies it. Bought by the kilogram. NO composition row yet: the BOM is a bulk-tablet BOM and names no packaging, so how much foil a box of 20 takes is recorded nowhere. Until that figure is entered in the Settings tab the foil has stock and a price but no requirement, and it never reaches the buy list. Packaging does not expire.'),
  ('BOX_ROYANOXICAM_20', 'علبة 20 قرص', 'Box of 20 tablets', 'count', 'piece', 'piece', 1, false, null, 550,
   'Royanoxicam''s own box, holding 20 tablets. Sato supplies it. Not interchangeable with any other product''s artwork, so it is its own material.'),
  ('LEAFLET_ROYANOXICAM', 'البروشور الداخلي — رويانوكسيكام', 'Leaflet — Royanoxicam', 'count', 'piece', 'piece', 1, false, null, 560,
   'Royanoxicam''s own leaflet. Sato supplies it. One per box, the same basis the box itself carries.')
on conflict (code) do nothing;

-- ── 5. Royanoxicam's material list, in the order the two papers number them ─────────────────────
insert into public.prodplan_product_materials (product_id, material_id, sort_order)
select p.id, m.id, v.sort_order
from public.prodplan_products p
join (values
  ('LORNOXICAM', 10),
  ('AEROSIL_200', 20),
  ('LACTOSE_MONO_200', 30),
  ('PVP_K30', 40),
  ('CROSCARMELLOSE_NA', 50),
  ('MAIZE_STARCH', 60),
  ('MAGNESIUM_STEARATE', 70),
  ('PURIFIED_WATER', 80),
  ('HPMC_E15', 90),
  ('PEG_6000', 100),
  ('TITANIUM_DIOXIDE', 110),
  ('TALC_PURIFIED', 120),
  ('ETHYL_ALCOHOL', 130),
  ('BLISTER_ALU_ROYANOXICAM', 140),
  ('BOX_ROYANOXICAM_20', 150),
  ('LEAFLET_ROYANOXICAM', 160)
) as v(code, sort_order) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'ROYANOXICAM'
on conflict (product_id, material_id) do nothing;

-- ── 6. The declaration of composition, per 155 mg tablet ────────────────────────────────────────
-- Straight off page 1 of the proposed COC, converted from milligrams per tablet to GRAMS per dose,
-- which is the base unit these materials are counted in.
--
-- 🔴 The eleven quantified lines add to exactly 0.155000 g — one whole coated tablet, 150 mg of
-- core plus 5 mg of coat. That total is the proof the figures are right, and multiplied by the
-- 200,000 tablets in one batch it reproduces the BOM's own "QTY/BATCH (Kg)" column to the digit:
-- lornoxicam 1.6, Aerosil 0.1, lactose 19.9, povidone 1.2, croscarmellose 0.8, maize starch 6,
-- magnesium stearate 0.4, Methocel 0.7, PEG 6000 0.15, titanium dioxide 0.09, talc 0.06 — and
-- 31.000 kg in total, which is the owner's "batch size is 31 kg".
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-10-20', v.note
from public.prodplan_products p
join (values
  ('LORNOXICAM',              'per_dose', 0.008000, 'sato',    '8 mg per tablet — the active'),
  ('AEROSIL_200',             'per_dose', 0.000500, 'factory', '0.5 mg per tablet'),
  ('LACTOSE_MONO_200',        'per_dose', 0.099500, 'factory', '99.5 mg per tablet'),
  ('PVP_K30',                 'per_dose', 0.006000, 'factory', '6 mg per tablet'),
  ('CROSCARMELLOSE_NA',       'per_dose', 0.004000, 'factory', '4 mg per tablet'),
  ('MAIZE_STARCH',            'per_dose', 0.030000, 'factory', '30 mg per tablet'),
  ('MAGNESIUM_STEARATE',      'per_dose', 0.002000, 'factory', '2 mg per tablet'),
  ('HPMC_E15',                'per_dose', 0.003500, 'factory', '3.5 mg per tablet — coat'),
  ('PEG_6000',                'per_dose', 0.000750, 'factory', '0.75 mg per tablet — coat'),
  ('TITANIUM_DIOXIDE',        'per_dose', 0.000450, 'factory', '0.45 mg per tablet — coat'),
  ('TALC_PURIFIED',           'per_dose', 0.000300, 'factory', '0.3 mg per tablet — coat'),
  -- One box and one leaflet per BOX of twenty tablets, which is 10,000 of each for one run.
  ('BOX_ROYANOXICAM_20',      'per_box',  1.000000, 'sato',    'One box per 20 tablets'),
  ('LEAFLET_ROYANOXICAM',     'per_box',  1.000000, 'sato',    'One leaflet per box')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'ROYANOXICAM'
on conflict (product_id, material_id, effective_from) do nothing;

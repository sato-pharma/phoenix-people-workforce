-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Saginkgo 120 mg hard gelatin capsule, made at Med Care.
--
-- WHAT THIS CHANGES: adds Med Care as a factory store, the Saginkgo product, five new materials, the
-- eight-row material list and the seven composition lines, and widens the measure_unit CHECK by one
-- value, `mg_capsule`. Every insert is `on conflict do nothing`, so nothing that already exists is
-- touched.
--
-- WHY: owner, 2026-11-03, sending Med Care's Certificate of Composition with
-- "العلبه ٣٠ كوكبسولات فارغه والومنيوم", then answering two questions:
-- "1 batch = 1000 box , box = 30 capsula" and "sato 5 items except the leaflet no leaflet in this
-- product". So Sato brings the ginkgo extract, the empty capsules, the aluminium and the box; Med
-- Care brings the four excipients; and there is NO leaflet material at all.
--
-- ── The geometry ────────────────────────────────────────────────────────────────────────────────
--
-- One batch is 1,000 boxes of 30 = 30,000 capsules. The certificate's "Total content Weight" is
-- 300 mg, so the batch is 9,000,000 mg = 9 kg of fill. The empty shell is NOT in that weight: it is
-- bought whole, so it is not part of the mix. 9,000,000 / 300 divides exactly.
--
-- ── Why `mg_capsule` and not `mg` ───────────────────────────────────────────────────────────────
--
-- `measure_unit` picks the words on the screen and the sheet as well as the unit, and `mg` says
-- "tablet" everywhere. A capsule product reading "30,000 tablets" is the same class of defect as a
-- powder reading "5 مل". The new value is arithmetically identical to `mg`.
--
-- 🔴 APPLY THIS TO PRODUCTION ONLY AFTER THE CODE THAT KNOWS `mg_capsule` IS LIVE. `coerceMeasureUnit`
-- reads an unknown unit as `ml`, so older code would show this product's batch as 9,000 litres.
--
-- ── The shell is one material ───────────────────────────────────────────────────────────────────
--
-- The certificate's "Cap opaque white (size 1)" table lists what the shell is MADE of. Sato buys the
-- finished empty capsule, so it is one count material at one a capsule, never gelatin plus titanium
-- dioxide plus parabens.
--
-- ── Three materials are shared ──────────────────────────────────────────────────────────────────
--
-- Pregelatinized starch, magnesium stearate and Aerosil 200 are the existing rows, linked and never
-- re-inserted. Each product reads held stock from its OWN factory store, so nothing counted at
-- Hochster or Egyphar reads as held at Med Care.
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- It seeds NO stock: nobody has reported a count, and an absent row says "never counted".
--
-- It gives the ALUMINIUM no composition row. Kilograms of foil a box takes are recorded nowhere, so
-- it reads as Sato's with no amount entered until he enters it in the Settings composition editor.
-- Who brings it lives on the product link, the Royanoxicam and Carvibradine precedent.
--
-- `overage_pct` is NULL on every line, so each inherits the module's own default. Whether the extract
-- is imported, and its lead time, are not recorded yet; both are a Settings edit.
--
-- ROLLBACK: this migration is additive.
--   delete from public.prodplan_products where code = 'SAGINKGO';  -- cascades its compositions and product_materials
--   delete from public.prodplan_materials where code in ('GINKGO_EXTRACT', 'ASCORBIC_ACID',
--     'CAPSULE_EMPTY_SAGINKGO', 'BLISTER_ALU_SAGINKGO', 'BOX_SAGINKGO');
--   delete from public.prodplan_locations where code = 'MEDCARE';
-- The CHECK may then be narrowed back to ml, g and mg. The three shared materials are never deleted.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one new product, one store, five materials, and a CHECK widened, never narrowed.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The unit that says "capsule" ─────────────────────────────────────────────────────────────
alter table public.prodplan_products
  drop constraint if exists prodplan_products_measure_unit_check;

alter table public.prodplan_products
  add constraint prodplan_products_measure_unit_check
  check (measure_unit = any (array['ml'::text, 'g'::text, 'mg'::text, 'mg_capsule'::text]));

-- ── 2. Med Care, the factory store ──────────────────────────────────────────────────────────────
insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values ('MEDCARE', 'مخزن المصنع — ميد كير', 'At the factory (Med Care)', true, 70)
on conflict (code) do nothing;

-- ── 3. Saginkgo 120 mg ──────────────────────────────────────────────────────────────────────────
-- `default_sample_units` is 0: no free-sample count has been named for this product.
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box,
  default_sample_units, notes
)
values (
  'SAGINKGO',
  'ساجنكو 120 مجم',
  'Saginkgo 120 mg',
  'Med Care',
  'mg_capsule',
  9000000, 300, 300, 300, true, 30,
  0,
  'Hard gelatin capsule, ginkgo biloba leaf extract 120 mg, toll-manufactured by Med Care for Sato Pharma. One batch is 1,000 boxes of 30 = 30,000 capsules = 9 kg of fill at 300 mg a capsule (owner, 2026-11-03). A capsule IS the dose and IS the saleable unit. Sato supplies the extract, the empty capsules, the aluminium and the box; Med Care the four excipients. There is no leaflet in this product. Seeded 2026-11-03 from Med Care''s Certificate of Composition.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'MEDCARE'
  and p.code = 'SAGINKGO'
  and p.factory_location_id is null;

-- ── 4. The five NEW materials ───────────────────────────────────────────────────────────────────
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('GINKGO_EXTRACT', 'مستخلص أوراق الجنكة بيلوبا', 'Ginkgo biloba leaf extract', 'mass', 'g', 'kg', 1000, false, null, 720,
   'Active ingredient, 120 mg a Saginkgo capsule. Sato supplies it. Certificate: leaves, ratio 50:1, ethanol and water, not less than 24% flavonol glycosides and 6% terpene lactones. Whether it is imported, and its lead time, are not recorded yet; both are a Settings edit.'),
  ('ASCORBIC_ACID', 'حمض الأسكوربيك', 'Ascorbic acid', 'mass', 'g', 'kg', 1000, false, null, 730,
   'Antioxidant, E300, 45 mg a Saginkgo capsule. Med Care supplies it.'),
  ('CAPSULE_EMPTY_SAGINKGO', 'كبسولة جيلاتين فارغة — ساجنكو', 'Empty gelatin capsule — Saginkgo', 'count', 'piece', 'piece', 1, false, null, 740,
   'Opaque white, size 1. Sato supplies it. One a capsule. Bought whole, so what the shell is made of is the certificate''s business and not a list of materials here. Packaging does not expire.'),
  ('BLISTER_ALU_SAGINKGO', 'فويل ألومنيوم للشريط — ساجنكو', 'Aluminium blister foil — Saginkgo', 'mass', 'g', 'kg', 1000, false, null, 750,
   'Sato supplies it. Bought by the kilogram. NO composition row yet: how much foil a box takes is recorded nowhere. Until that figure is entered in the Settings tab the foil has stock and a price but no requirement, and it never reaches the buy list. Packaging does not expire.'),
  ('BOX_SAGINKGO', 'علبة ساجنكو', 'Box — Saginkgo', 'count', 'piece', 'piece', 1, false, null, 760,
   'Saginkgo''s own box, 30 capsules. Sato supplies it. Not interchangeable with any other product''s artwork, so it is its own material.')
on conflict (code) do nothing;

-- ── 5. Saginkgo's material list, in the certificate's order, then the packaging ─────────────────
-- Only the foil names a supplier here: it is the one material with no formula line, and a line in
-- force always wins over this column.
insert into public.prodplan_product_materials (product_id, material_id, sort_order, supplier)
select p.id, m.id, v.sort_order, v.supplier
from public.prodplan_products p
join (values
  ('GINKGO_EXTRACT', 10, null::text),
  ('PREGELATINIZED_STARCH', 20, null::text),
  ('ASCORBIC_ACID', 30, null::text),
  ('MAGNESIUM_STEARATE', 40, null::text),
  ('AEROSIL_200', 50, null::text),
  ('CAPSULE_EMPTY_SAGINKGO', 60, null::text),
  ('BLISTER_ALU_SAGINKGO', 70, 'sato'::text),
  ('BOX_SAGINKGO', 80, null::text)
) as v(code, sort_order, supplier) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'SAGINKGO'
on conflict (product_id, material_id) do nothing;

-- ── 6. The certificate, per 300 mg capsule ──────────────────────────────────────────────────────
-- Milligrams per capsule converted to GRAMS per dose, the base unit these materials count in.
-- 🔴 The five weighed lines add to exactly 0.300000 g, the certificate's "Total content Weight", and
-- times 30,000 capsules that is the 9 kg batch.
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-11-03', v.note
from public.prodplan_products p
join (values
  ('GINKGO_EXTRACT',         'per_dose', 0.120000, 'sato',    '120 mg per capsule — active'),
  ('PREGELATINIZED_STARCH',  'per_dose', 0.130000, 'factory', '130 mg per capsule — diluent, E1422'),
  ('ASCORBIC_ACID',          'per_dose', 0.045000, 'factory', '45 mg per capsule — antioxidant, E300'),
  ('MAGNESIUM_STEARATE',     'per_dose', 0.003000, 'factory', '3 mg per capsule — lubricant, E572'),
  ('AEROSIL_200',            'per_dose', 0.002000, 'factory', '2 mg per capsule — glidant, silicon dioxide E551'),
  ('CAPSULE_EMPTY_SAGINKGO', 'per_dose', 1.000000, 'sato',    'One empty capsule per capsule'),
  ('BOX_SAGINKGO',           'per_box',  1.000000, 'sato',    'One box per box of capsules')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'SAGINKGO'
on conflict (product_id, material_id, effective_from) do nothing;

commit;

-- Timestamp 20261103154230 was minted to sort after every migration already on main.

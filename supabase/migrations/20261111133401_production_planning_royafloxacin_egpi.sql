-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royafloxacin 500 mg: Medizen's figures corrected, its free sample in a box of
-- its own, and a second Royafloxacin made at EGPI holding the 600 kg of levofloxacin.
--
-- WHAT THIS CHANGES:
--   1. ROYAFLOXACIN (Medizen) is renamed "… — Medizen", shows 70 kg a batch and a 847.6 mg tablet
--      (the two display columns from 20261111133400), and its free sample becomes a box of its own
--      holding ONE strip of TWO tablets (`sample_in_own_box`, sample_unit_ml = 2 × 815 = 1,630).
--      The counting geometry is untouched: 80,000 tablets at the 815 mg core, 8,000 boxes of 10.
--   2. One new material, BOX_ROYAFLOXACIN_SAMPLE, one per free sample, from Sato.
--   3. ROYAFLOXACIN_EGPI, a new product on the EGPI store: an 80 kg batch of the same 847.6 mg tablet,
--      counted as 94,380 tablets = 9,438 boxes of 10 (80,000,000 / 847.6 = 94,384, rounded down to
--      whole boxes), so run_volume_ml = 94,380 × 815 = 76,919,700 at the core weight.
--      Only Sato's four materials and the sample box are on it: levofloxacin 512.5 mg a tablet, the
--      box and the leaflet one a box, the sample box one a sample, and the foil Sato's with no amount.
--   4. The 600 kg levofloxacin lot (expiry 2031-05-30) moves from Medizen to EGPI: two append-only
--      `adjustment` rows, Medizen's lot closed at zero and EGPI's opened at 600 kg.
--
-- WHY: owner, 2026-11-11, forwarding Sato's request ("Batch size: 80,000 tablets … FMS: 1 box
-- containing 1 strip × 2 tablets … For Royafloxacin 500 manufactured at EGPI Factory … Batch size:
-- 80 kg … Current stock: 600 kg of Levofloxacin only"), then answering three multiple choices:
-- "847.6 mg, 70 kg as stated", "Same tablet as Medizen" and "Same 600 kg, move to EGPI". The 600 kg
-- was seeded at Medizen on 2026-11-03 from Medizen's 02/09/2026 sheet, where it sat in quarantine.
--
-- ROLLBACK (by hand, in this order):
--   insert the two stock rows reversed (EGPI lot to 0, Medizen lot to 600000, source 'adjustment');
--   delete from public.prodplan_products where code = 'ROYAFLOXACIN_EGPI';   -- cascades lines and links
--   delete from public.prodplan_compositions c using public.prodplan_materials m
--     where c.material_id = m.id and m.code = 'BOX_ROYAFLOXACIN_SAMPLE';
--   delete from public.prodplan_product_materials pm using public.prodplan_materials m
--     where pm.material_id = m.id and m.code = 'BOX_ROYAFLOXACIN_SAMPLE';
--   delete from public.prodplan_materials where code = 'BOX_ROYAFLOXACIN_SAMPLE';
--   update public.prodplan_products set name_ar = 'رويافلوكساسين 500 مجم', name_en = 'Royafloxacin 500 mg',
--     batch_weight_display = null, unit_weight_display = null, sample_in_own_box = false,
--     sample_unit_ml = 815 where code = 'ROYAFLOXACIN';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one product updated, one product and one material added,
-- eleven link and formula rows, two stock rows. Nothing is deleted.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Medizen's Royafloxacin ───────────────────────────────────────────────────────────────────
update public.prodplan_products
set name_ar = 'رويافلوكساسين 500 مجم — ميديزن',
    name_en = 'Royafloxacin 500 mg — Medizen',
    batch_weight_display = 70,
    unit_weight_display = 847.6,
    sample_in_own_box = true,
    sample_unit_ml = 1630,
    notes = 'Film-coated tablet, levofloxacin 500 mg, toll-manufactured by Medizen for Sato Pharma. One batch is 80,000 tablets, shown as 70 kg, the factory''s own figure; the coated tablet is 847.6 mg (Medizen''s paper). The engine counts at the 815 mg core (65.2 kg), which is exact; no quantity depends on the kilograms. Ten tablets to a box, 2 strips of 5, so one batch is 8,000 boxes. The free sample is a box of its own: 1 strip of 2 tablets. Sato brings the levofloxacin, the aluminium foil, the boxes and the leaflet; Medizen the rest. Corrected 2026-11-11.',
    updated_at = now()
where code = 'ROYAFLOXACIN';

-- ── 2. The free sample's box ────────────────────────────────────────────────────────────────────
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('BOX_ROYAFLOXACIN_SAMPLE', 'علبة عينة رويافلوكساسين — شريط قرصين', 'Sample box — Royafloxacin, 1 strip of 2 tablets', 'count', 'piece', 'piece', 1, false, null, 835,
   'The free medical sample''s box: one strip of 2 tablets. Sato supplies it. One a sample, and it reads zero until an order names samples.')
on conflict (code) do nothing;

-- ── 3. Royafloxacin at EGPI ─────────────────────────────────────────────────────────────────────
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box,
  strips_per_box, default_sample_units, sample_in_own_box, batch_weight_display, unit_weight_display, notes
)
values (
  'ROYAFLOXACIN_EGPI',
  'رويافلوكساسين 500 مجم — إي جي بي آي',
  'Royafloxacin 500 mg — EGPI',
  'EGPI',
  'mg',
  76919700, 815, 815, 1630, true, 10,
  2, 0, true, 80, 847.6,
  'Film-coated tablet, levofloxacin 500 mg, made at EGPI for Sato Pharma. One batch is 80 kg of the same 847.6 mg tablet as Medizen''s, counted as 94,380 tablets = 9,438 boxes of 10 (owner, 2026-11-11, "Same tablet as Medizen"); the engine counts at the 815 mg core. Levofloxacin 512.5 mg a tablet. Only what Sato supplies is listed: levofloxacin, aluminium foil, boxes and leaflets, plus the free sample''s box (1 strip of 2 tablets). Added 2026-11-11.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'EGPI'
  and p.code = 'ROYAFLOXACIN_EGPI'
  and p.factory_location_id is null;

-- ── 4. The material lists ───────────────────────────────────────────────────────────────────────
-- Only the foil names a supplier here: it has no formula line, and a line in force always wins.
insert into public.prodplan_product_materials (product_id, material_id, sort_order, supplier)
select p.id, m.id, v.sort_order, v.supplier
from public.prodplan_products p
join (values
  ('ROYAFLOXACIN_EGPI', 'LEVOFLOXACIN_HEMIHYDRATE', 10, null::text),
  ('ROYAFLOXACIN_EGPI', 'BLISTER_ALU_ROYAFLOXACIN', 160, 'sato'::text),
  ('ROYAFLOXACIN_EGPI', 'BOX_ROYAFLOXACIN_10', 170, null::text),
  ('ROYAFLOXACIN_EGPI', 'LEAFLET_ROYAFLOXACIN', 180, null::text),
  ('ROYAFLOXACIN_EGPI', 'BOX_ROYAFLOXACIN_SAMPLE', 175, null::text),
  ('ROYAFLOXACIN', 'BOX_ROYAFLOXACIN_SAMPLE', 175, null::text)
) as v(product_code, code, sort_order, supplier) on p.code = v.product_code
join public.prodplan_materials m on m.code = v.code
on conflict (product_id, material_id) do nothing;

-- ── 5. The formula lines ────────────────────────────────────────────────────────────────────────
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, 'sato', date '2026-11-11', v.note
from public.prodplan_products p
join (values
  ('ROYAFLOXACIN_EGPI', 'LEVOFLOXACIN_HEMIHYDRATE', 'per_dose',        0.512500, '512.5 mg per tablet — the active, equal to 500 mg of levofloxacin anhydrous'),
  ('ROYAFLOXACIN_EGPI', 'BOX_ROYAFLOXACIN_10',      'per_box',         1.000000, 'One box per 10 tablets'),
  ('ROYAFLOXACIN_EGPI', 'LEAFLET_ROYAFLOXACIN',     'per_box',         1.000000, 'One leaflet per box'),
  ('ROYAFLOXACIN_EGPI', 'BOX_ROYAFLOXACIN_SAMPLE',  'per_sample_unit', 1.000000, 'One sample box per free sample'),
  ('ROYAFLOXACIN',      'BOX_ROYAFLOXACIN_SAMPLE',  'per_sample_unit', 1.000000, 'One sample box per free sample')
) as v(product_code, code, basis, qty, note) on p.code = v.product_code
join public.prodplan_materials m on m.code = v.code
on conflict (product_id, material_id, effective_from) do nothing;

-- ── 6. The 600 kg of levofloxacin moves from Medizen to EGPI ────────────────────────────────────
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, v.qty, date '2026-11-11', date '2031-05-30', 'adjustment', v.note
from public.prodplan_materials m
join (values
  ('MEDIZEN', 0.000000::numeric,
   'Moved to EGPI 2026-11-11: the 600 kg lot (control 2607R0207) is EGPI''s stock, not Medizen''s (owner, "Same 600 kg, move to EGPI").'),
  ('EGPI', 600000.000000::numeric,
   'Moved from Medizen 2026-11-11: 600 kg of levofloxacin, EGPI''s current stock per Sato''s request (owner, "Same 600 kg, move to EGPI").')
) as v(location_code, qty, note) on true
join public.prodplan_locations l on l.code = v.location_code
where m.code = 'LEVOFLOXACIN_HEMIHYDRATE'
  and not exists (
    select 1 from public.prodplan_stock_entries s
    where s.material_id = m.id
      and s.location_id = l.id
      and s.expiry_date = date '2031-05-30'
      and s.as_of_date = date '2026-11-11'
  );

commit;

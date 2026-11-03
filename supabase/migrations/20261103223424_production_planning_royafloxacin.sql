-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royafloxacin 500 mg film-coated tablet, made at Medizen.
--
-- WHAT THIS CHANGES: adds the Royafloxacin product on the existing Medizen store, seven new
-- materials, the eighteen-row material list, the fourteen composition lines and four stock rows.
-- Every insert is guarded, so nothing that already exists is touched.
--
-- WHY: owner, 2026-11-03, sending Medizen's composition paper and Medizen's stock sheet dated
-- 02/09/2026, then answering "80 000 tab  -  65.2 kg" for the batch and "Same as Royanoxicam" for who
-- brings what. Of the sheet, which lists both products: "خليه يختار بس الليفو فلوكساسين فقط هو ده
-- الاكتف بتاع الماده بتاع المنتج بتاعنا" — so the lornoxicam on it is NOT this product's and no
-- Royanoxicam row moves here.
--
-- This corrects `20261029040000`'s header, which says no Royafloxacin formula had been sent. It had:
-- page 2 of the paper sent on 2026-10-20 is this same formula, and `20261020200000` says so.
--
-- ── The geometry ────────────────────────────────────────────────────────────────────────────────
--
-- 80,000 tablets at 65.2 kg is 815 mg a tablet: his batch weight is the CORE, the paper's "Total Core
-- Tablet Weight". 65,200,000 / 815 divides exactly. The coated 847.6 mg could not be stored at all
-- (`dose_ml` is an integer), and the coat's four lines still count per tablet, on top of the 65.2 kg:
-- one batch consumes 67.808 kg of weighed material. Ten tablets to a box, 2 strips of 5 (Medizen's
-- sheet, and section 6.5 of the product summary), so 8,000 boxes a batch with nothing left over.
--
-- ── Who brings what ─────────────────────────────────────────────────────────────────────────────
--
-- Sato brings the levofloxacin, the foil, the box and the leaflet; Medizen every inactive. Overage is
-- NULL on every line, so each inherits the module's own default.
--
-- ── Grades the paper keeps apart ────────────────────────────────────────────────────────────────
--
-- The core's "Talc Powder" (20 mg) and the coat's "Purified Talc Powder" (1 mg) are two materials, as
-- are the core's "Ethyl Alcohol 95%" and the coat's "Ethyl Alcohol". Eleven materials are the existing
-- rows, linked and never re-inserted. Each product reads held stock from its OWN factory store, so
-- what Hochster or Egyphar counted never reads as held at Medizen.
--
-- ── The stock, off the sheet of 02/09/2026 ──────────────────────────────────────────────────────
--
-- Counted in each material's base unit, as_of 2026-09-02:
--   Levofloxacin  600,000 g  store 5, QUARANTINE, in 09/07/2026, control 2607R0207, expiry 30/05/2031.
--   Aluminium     30,910 g   store 8, control 2512P0807.
--   Box           23,470     store 8, control 2605P0220.
--   Leaflet       27,120     store 8, control 2605P0221.
-- The levofloxacin counts as held even though it sits in quarantine: it is all there is on the sheet,
-- and ignoring it would put 600 kg he already owns on the buy list. The note says where it sits.
-- Packaging carries no expiry date (owner rule).
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- The photo of the sheet stops at the start of store 23, so anything further down is not seeded. The
-- 19/04/2026 sheet's Royafloxacin rows are superseded and not seeded either.
--
-- The foil gets no composition line: kilograms of foil a box takes are on neither paper, so it reads
-- as Sato's with no amount until he enters it in the Settings composition editor. Its 30.91 kg is
-- recorded, and it reaches no buy list. The three solvents get no line (Q.S., they evaporate); the
-- product link says the factory's.
--
-- ROLLBACK: additive.
--   delete from public.prodplan_stock_entries s using public.prodplan_materials m
--     where s.material_id = m.id and m.code in ('LEVOFLOXACIN_HEMIHYDRATE', 'BLISTER_ALU_ROYAFLOXACIN',
--       'BOX_ROYAFLOXACIN_10', 'LEAFLET_ROYAFLOXACIN');
--   delete from public.prodplan_products where code = 'ROYAFLOXACIN';  -- cascades its lines and links
--   delete from public.prodplan_materials where code in ('LEVOFLOXACIN_HEMIHYDRATE',
--     'SODIUM_STARCH_GLYCOLATE', 'TALC_POWDER', 'ETHYL_ALCOHOL_95', 'BLISTER_ALU_ROYAFLOXACIN',
--     'BOX_ROYAFLOXACIN_10', 'LEAFLET_ROYAFLOXACIN');
-- The shared materials and the Medizen store are never deleted.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one new product, seven materials and four stock rows.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Royafloxacin 500 mg ──────────────────────────────────────────────────────────────────────
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box,
  strips_per_box, default_sample_units, notes
)
values (
  'ROYAFLOXACIN',
  'رويافلوكساسين 500 مجم',
  'Royafloxacin 500 mg',
  'Medizen Pharmaceutical Industries',
  'mg',
  65200000, 815, 815, 815, true, 10,
  2, 0,
  'Film-coated tablet, levofloxacin 500 mg, toll-manufactured by Medizen for Sato Pharma. One batch is 80,000 tablets = 65.2 kg at the 815 mg core (owner, 2026-11-03); the coated tablet is 847.6 mg. Ten tablets to a box, 2 strips of 5, so one run is exactly 8,000 boxes. Sato brings the levofloxacin, the aluminium foil, the box and the leaflet; Medizen the rest. Seeded 2026-11-03 from Medizen''s composition paper and its stock sheet dated 02/09/2026.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'MEDIZEN'
  and p.code = 'ROYAFLOXACIN'
  and p.factory_location_id is null;

-- ── 2. The seven NEW materials ──────────────────────────────────────────────────────────────────
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('LEVOFLOXACIN_HEMIHYDRATE', 'ليفوفلوكساسين هيميهيدرات', 'Levofloxacin hemihydrate', 'mass', 'g', 'kg', 1000, false, null, 780,
   'Active ingredient, 512.5 mg a Royafloxacin tablet, equivalent to 500 mg of levofloxacin anhydrous. Sato supplies it. Whether it is imported, and its lead time, are not recorded yet; both are a Settings edit.'),
  ('SODIUM_STARCH_GLYCOLATE', 'صوديوم ستارش جليكولات', 'Sodium starch glycolate', 'mass', 'g', 'kg', 1000, false, null, 790,
   'Disintegrant, 30 mg a Royafloxacin tablet. Medizen supplies it.'),
  ('TALC_POWDER', 'مسحوق التلك', 'Talc powder', 'mass', 'g', 'kg', 1000, false, null, 800,
   'Glidant in the core, 20 mg a Royafloxacin tablet. Medizen supplies it. The paper names it apart from the coat''s purified talc, so it is its own material.'),
  ('ETHYL_ALCOHOL_95', 'كحول إيثيلي 95%', 'Ethyl alcohol 95%', 'mass', 'g', 'kg', 1000, false, null, 810,
   'Solvent in the core, as needed, evaporates during processing, so it has no formula line. Medizen supplies it. The paper names it apart from the coat''s ethyl alcohol.'),
  ('BLISTER_ALU_ROYAFLOXACIN', 'فويل ألومنيوم للشريط — رويافلوكساسين', 'Aluminium blister foil — Royafloxacin', 'mass', 'g', 'kg', 1000, false, null, 820,
   'The 250 mm foil. Sato supplies it. Bought by the kilogram. NO composition row yet: how much foil a box takes is recorded nowhere. Until that figure is entered in the Settings tab the foil has stock and a price but no requirement, and it never reaches the buy list. Packaging does not expire.'),
  ('BOX_ROYAFLOXACIN_10', 'علبة رويافلوكساسين 10 أقراص', 'Box — Royafloxacin, 10 tablets', 'count', 'piece', 'piece', 1, false, null, 830,
   'Royafloxacin''s own box, 10 tablets in 2 strips. Sato supplies it. Not interchangeable with any other product''s artwork, so it is its own material.'),
  ('LEAFLET_ROYAFLOXACIN', 'البروشور الداخلي — رويافلوكساسين', 'Leaflet — Royafloxacin', 'count', 'piece', 'piece', 1, false, null, 840,
   'Royafloxacin''s own leaflet, the 2-strip new-data artwork. Sato supplies it. One per box, the same basis the box itself carries.')
on conflict (code) do nothing;

-- ── 3. The material list, in the paper's order, then the packaging ──────────────────────────────
-- Only the materials with no formula line name a supplier here: a line in force always wins over this
-- column, and the foil and the three solvents have none.
insert into public.prodplan_product_materials (product_id, material_id, sort_order, supplier)
select p.id, m.id, v.sort_order, v.supplier
from public.prodplan_products p
join (values
  ('LEVOFLOXACIN_HEMIHYDRATE', 10, null::text),
  ('MCC_PH102', 20, null::text),
  ('AEROSIL_200', 30, null::text),
  ('PVP_K30', 40, null::text),
  ('CROSCARMELLOSE_NA', 50, null::text),
  ('SODIUM_STARCH_GLYCOLATE', 60, null::text),
  ('TALC_POWDER', 70, null::text),
  ('MAGNESIUM_STEARATE', 80, null::text),
  ('ETHYL_ALCOHOL_95', 90, 'factory'::text),
  ('HPMC_E15', 100, null::text),
  ('PEG_6000', 110, null::text),
  ('TITANIUM_DIOXIDE', 120, null::text),
  ('TALC_PURIFIED', 130, null::text),
  ('ETHYL_ALCOHOL', 140, 'factory'::text),
  ('PURIFIED_WATER', 150, 'factory'::text),
  ('BLISTER_ALU_ROYAFLOXACIN', 160, 'sato'::text),
  ('BOX_ROYAFLOXACIN_10', 170, null::text),
  ('LEAFLET_ROYAFLOXACIN', 180, null::text)
) as v(code, sort_order, supplier) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'ROYAFLOXACIN'
on conflict (product_id, material_id) do nothing;

-- ── 4. The paper, per tablet, in grams per dose ─────────────────────────────────────────────────
-- 🔴 The eight core lines add to exactly 0.815000 g, the paper's "Total Core Tablet Weight", and with
-- the coat's four to 0.847600 g, its "Total Coated Tablet Weight".
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-11-03', v.note
from public.prodplan_products p
join (values
  ('LEVOFLOXACIN_HEMIHYDRATE', 'per_dose', 0.512500, 'sato',    '512.5 mg per tablet — the active, equal to 500 mg of levofloxacin anhydrous'),
  ('MCC_PH102',                'per_dose', 0.153500, 'factory', '153.5 mg per tablet — filler'),
  ('AEROSIL_200',              'per_dose', 0.008000, 'factory', '8 mg per tablet — glidant'),
  ('PVP_K30',                  'per_dose', 0.048000, 'factory', '48 mg per tablet — binder'),
  ('CROSCARMELLOSE_NA',        'per_dose', 0.035000, 'factory', '35 mg per tablet — disintegrant'),
  ('SODIUM_STARCH_GLYCOLATE',  'per_dose', 0.030000, 'factory', '30 mg per tablet — disintegrant'),
  ('TALC_POWDER',              'per_dose', 0.020000, 'factory', '20 mg per tablet — glidant'),
  ('MAGNESIUM_STEARATE',       'per_dose', 0.008000, 'factory', '8 mg per tablet — lubricant'),
  ('HPMC_E15',                 'per_dose', 0.019560, 'factory', '19.56 mg per tablet — coat'),
  ('PEG_6000',                 'per_dose', 0.004890, 'factory', '4.89 mg per tablet — coat'),
  ('TITANIUM_DIOXIDE',         'per_dose', 0.007150, 'factory', '7.15 mg per tablet — coat'),
  ('TALC_PURIFIED',            'per_dose', 0.001000, 'factory', '1 mg per tablet — coat'),
  ('BOX_ROYAFLOXACIN_10',      'per_box',  1.000000, 'sato',    'One box per 10 tablets'),
  ('LEAFLET_ROYAFLOXACIN',     'per_box',  1.000000, 'sato',    'One leaflet per box')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'ROYAFLOXACIN'
on conflict (product_id, material_id, effective_from) do nothing;

-- ── 5. Medizen's stock, off the 02/09/2026 sheet ────────────────────────────────────────────────
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, v.qty, date '2026-09-02', v.expiry, 'factory_report', v.note
from public.prodplan_locations l
join (values
  ('LEVOFLOXACIN_HEMIHYDRATE', 600000.000000::numeric, date '2031-05-30',
   'Medizen stock sheet 02/09/2026 — store 5, QUARANTINE raw materials, in 09/07/2026, control 2607R0207, 600 kg.'),
  ('BLISTER_ALU_ROYAFLOXACIN', 30910.000000::numeric,  null::date,
   'Medizen stock sheet 02/09/2026 — store 8, control 2512P0807, 30.91 kg. Packaging carries no expiry date.'),
  ('BOX_ROYAFLOXACIN_10',      23470.000000::numeric,  null::date,
   'Medizen stock sheet 02/09/2026 — store 8, control 2605P0220. Packaging carries no expiry date.'),
  ('LEAFLET_ROYAFLOXACIN',     27120.000000::numeric,  null::date,
   'Medizen stock sheet 02/09/2026 — store 8, control 2605P0221. Packaging carries no expiry date.')
) as v(code, qty, expiry, note) on true
join public.prodplan_materials m on m.code = v.code
where l.code = 'MEDIZEN'
  and not exists (
    select 1 from public.prodplan_stock_entries s
    where s.material_id = m.id
      and s.location_id = l.id
      and s.as_of_date = date '2026-09-02'
  );

commit;

-- Timestamp 20261103223424 was minted to sort after every migration already on main.

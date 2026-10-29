-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royanoxicam 8 mg made at a SECOND factory, Medizen, with Medizen's old stock.
--
-- WHAT THIS CHANGES: adds Medizen back as a factory store, a second Royanoxicam product made there
-- (the same formula, geometry and supplier split as Egyphar's), Medizen's stock of the four things
-- Sato brings, and a factory suffix on the Egyphar product's name so the two read apart in every
-- picker. Every insert is guarded, so nothing that already exists is touched.
--
-- WHY: owner, 2026-10-29, sending `stock 19-4-2026.pdf` (Medizen's stock sheet, "Date 19/04/2026"):
-- Egyphar has no stock of Royanoxicam's materials and Medizen does, so the same product is to be
-- added on Medizen "بالاستوكات الموجوده عندك دي، نفس بيان التركيب اللي كنت بعته لك قبل كده" — with
-- the stock on that sheet and the same composition he sent before. Egyphar keeps its own product.
--
-- ── Why a second PRODUCT, not a second factory on the one product ──────────────────────────────
--
-- A product has ONE factory store (`factory_location_id`), and that is what the plan reads as "held
-- at the factory". Stock at another factory's store is never counted for a product
-- (`stockForProduct`, shipped with this migration): Medizen's boxes cannot go into an Egyphar batch.
-- So each factory gets its own product row, and each plan sees only its own factory's stock plus
-- Sato's own store.
--
-- ── Why Medizen comes back under the code MEDIZEN ───────────────────────────────────────────────
--
-- `20261021004800` RENAMED the original MEDIZEN row to EGYPHAR (it held nothing then). That row is
-- Egyphar now and keeps its id, so its history is untouched; this inserts a NEW location with the
-- old code. On a database replayed from scratch the order still holds: created, renamed, created.
--
-- ── The stock, off the sheet ────────────────────────────────────────────────────────────────────
--
-- Counted in each material's base unit (grams, pieces), as_of 2026-04-19, the sheet's own date:
--   Lornoxicam    131 g        store 6, control 220200282, expiry 06/12/2026.
--   Aluminium     71,290.5 g   store 8, 64.7905 kg, plus store 23 (Kranten Packaging Toll) 6.5 kg,
--                              control 220300373. One standing figure: both are Medizen's.
--   Box           10,244       store 23: 8,629 (control 210900940) + 165 (230100008) + 1,450
--                              (220700967).
--   Leaflet       3,990        store 8, control 231100927.
-- Packaging carries NO expiry date (owner rule), so the foil, the boxes and the leaflets are
-- undated, and the sheet's own packaging dates — 30/09/2026 on the 8,629 boxes — stay in the note.
-- The loader keeps one standing figure per material, store and expiry, so the three box lots are
-- one row.
--
-- The sheet's Royafloxacin 500 rows are NOT seeded: Royafloxacin is not a product in the planner
-- and no formula for it has been sent.
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- The aluminium foil gets no composition line, at either factory: "the almunumnblister leave empty
-- for now" (owner, 2026-10-21). Who brings it is on the product link — Sato — as on Egyphar's.
-- The water and the alcohol get no line either (Q.S., they evaporate); the link says the factory's.
-- `overage_pct` is NULL on every line, so each inherits the module's own default.
--
-- ROLLBACK: additive.
--   delete from public.prodplan_stock_entries s using public.prodplan_locations l
--     where s.location_id = l.id and l.code = 'MEDIZEN';
--   delete from public.prodplan_products where code = 'ROYANOXICAM_MEDIZEN';  -- cascades its lines and links
--   delete from public.prodplan_locations where code = 'MEDIZEN';
--   update public.prodplan_products set name_en = 'Royanoxicam 8 mg', name_ar = 'رويانوكسيكام 8 مجم'
--     where code = 'ROYANOXICAM';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one location, one product, sixteen links, thirteen lines, four stock rows and one
-- rename.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Medizen, a factory store again ───────────────────────────────────────────────────────────
insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values ('MEDIZEN', 'مخزن المصنع — ميديزن', 'At the factory (Medizen)', true, 60)
on conflict (code) do nothing;

-- ── 2. The two Royanoxicam products read apart ──────────────────────────────────────────────────
update public.prodplan_products
set name_en = 'Royanoxicam 8 mg — Egyphar',
    name_ar = 'رويانوكسيكام 8 مجم — إيجيفار'
where code = 'ROYANOXICAM'
  and name_en = 'Royanoxicam 8 mg';

-- The geometry is Egyphar's to the digit: a FIXED 31 kg = 200,000 tablets of 155 mg, 20 to a box.
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box,
  default_sample_units, notes
)
values (
  'ROYANOXICAM_MEDIZEN',
  'رويانوكسيكام 8 مجم — ميديزن',
  'Royanoxicam 8 mg — Medizen',
  'Medizen Pharmaceutical Industries',
  'mg',
  31000000, 155, 155, 155, true, 20,
  0,
  'Film-coated tablet, toll-manufactured by Medizen for Sato Pharma — the same product as Royanoxicam 8 mg at Egyphar, made at a second factory that holds old stock of its materials. One batch is a FIXED 31 kg = 200,000 tablets of 155 mg; 20 tablets to a box, so one run is exactly 10,000 boxes. Shelf life 3 years. The formula and the supplier split are Egyphar''s: Sato brings the lornoxicam, the box, the leaflet and the aluminium foil; Medizen the rest. Added 2026-10-29 at the owner''s word, with Medizen''s stock sheet dated 19/04/2026.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'MEDIZEN'
  and p.code = 'ROYANOXICAM_MEDIZEN'
  and p.factory_location_id is null;

-- ── 3. The material list — Egyphar's own sixteen links, order and supplier included ─────────────
insert into public.prodplan_product_materials (product_id, material_id, sort_order, supplier)
select medizen.id, pm.material_id, pm.sort_order, pm.supplier
from public.prodplan_products medizen
join public.prodplan_products egyphar on egyphar.code = 'ROYANOXICAM'
join public.prodplan_product_materials pm on pm.product_id = egyphar.id
where medizen.code = 'ROYANOXICAM_MEDIZEN'
on conflict (product_id, material_id) do nothing;

-- ── 4. The same formula, per 155 mg tablet, in grams per dose ───────────────────────────────────
-- Written out rather than copied, so it is the composition he sent — the thirteen lines of
-- `20261020200000` — whatever later edit a line at Egyphar carries.
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-10-29', v.note
from public.prodplan_products p
join (values
  ('LORNOXICAM',          'per_dose', 0.008000, 'sato',    '8 mg per tablet — the active'),
  ('AEROSIL_200',         'per_dose', 0.000500, 'factory', '0.5 mg per tablet'),
  ('LACTOSE_MONO_200',    'per_dose', 0.099500, 'factory', '99.5 mg per tablet'),
  ('PVP_K30',             'per_dose', 0.006000, 'factory', '6 mg per tablet'),
  ('CROSCARMELLOSE_NA',   'per_dose', 0.004000, 'factory', '4 mg per tablet'),
  ('MAIZE_STARCH',        'per_dose', 0.030000, 'factory', '30 mg per tablet'),
  ('MAGNESIUM_STEARATE',  'per_dose', 0.002000, 'factory', '2 mg per tablet'),
  ('HPMC_E15',            'per_dose', 0.003500, 'factory', '3.5 mg per tablet — coat'),
  ('PEG_6000',            'per_dose', 0.000750, 'factory', '0.75 mg per tablet — coat'),
  ('TITANIUM_DIOXIDE',    'per_dose', 0.000450, 'factory', '0.45 mg per tablet — coat'),
  ('TALC_PURIFIED',       'per_dose', 0.000300, 'factory', '0.3 mg per tablet — coat'),
  ('BOX_ROYANOXICAM_20',  'per_box',  1.000000, 'sato',    'One box per 20 tablets'),
  ('LEAFLET_ROYANOXICAM', 'per_box',  1.000000, 'sato',    'One leaflet per box')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'ROYANOXICAM_MEDIZEN'
on conflict (product_id, material_id, effective_from) do nothing;

-- ── 5. Medizen's stock, off the 19/04/2026 sheet ────────────────────────────────────────────────
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, v.qty, date '2026-04-19', v.expiry, 'factory_report', v.note
from public.prodplan_locations l
join (values
  ('LORNOXICAM',              131.000000::numeric,   date '2026-12-06',
   'Medizen stock sheet 19/04/2026 — store 6, control 220200282, 0.131 kg.'),
  ('BLISTER_ALU_ROYANOXICAM', 71290.500000::numeric, null::date,
   'Medizen stock sheet 19/04/2026 — control 220300373: store 8 64.7905 kg plus store 23 (Kranten Packaging Toll) 6.5 kg. Packaging carries no expiry date.'),
  ('BOX_ROYANOXICAM_20',      10244.000000::numeric, null::date,
   'Medizen stock sheet 19/04/2026 — store 23: 8,629 (control 210900940, the sheet dates it 30/09/2026) + 165 (230100008) + 1,450 (220700967). Packaging carries no expiry date.'),
  ('LEAFLET_ROYANOXICAM',     3990.000000::numeric,  null::date,
   'Medizen stock sheet 19/04/2026 — store 8, control 231100927. Packaging carries no expiry date.')
) as v(code, qty, expiry, note) on true
join public.prodplan_materials m on m.code = v.code
where l.code = 'MEDIZEN'
  and not exists (
    select 1 from public.prodplan_stock_entries s
    where s.material_id = m.id
      and s.location_id = l.id
      and s.as_of_date = date '2026-04-19'
  );

commit;

-- Timestamp 20261029040000 was minted to sort after every migration already on main.

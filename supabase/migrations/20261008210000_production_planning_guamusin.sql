-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Guamusin, and the five things the module needed before it could hold a
-- SECOND product at all.
--
-- Owner, 2026-10-08: "follow the sheet i uploaded 100%". The sheet is
-- `xlsx/Guamusin-data-checked.xlsx`, and every figure seeded at the bottom of this file comes from
-- it. Guamusin is a powder in 5 g sachets, 12 sachets to a box, toll-manufactured by DBK Pharma on
-- a FIXED 100 kg batch; his order is 6 runs = 600 kg = 120,000 sachets = exactly 10,000 boxes.
--
-- ── Why this is not thirteen inserts ────────────────────────────────────────────────────────────
--
-- The module was built around exactly one product and one factory, so seeding a second one without
-- the changes below would have been wrong in four visible ways:
--
--   1. The buy list loops over EVERY material in the system, so Guamusin's thirteen would have
--      appeared on Ivyronc's screen as "formula not entered". Fixed by prodplan_product_materials:
--      a product now owns its own material list, and a material may belong to both (citric acid and
--      the lemon flavour genuinely do).
--   2. "The factory" was whichever location carried is_factory first. Adding DBK would have
--      re-pointed Ivyronc's "send to the factory" and "left after the run" columns at DBK. Fixed by
--      prodplan_products.factory_location_id — a product names its own factory.
--   3. A carton holding 12 sachets is one carton per BOX, not one per sachet, and the only bases
--      were per_dose / per_packaging_set / per_good_unit / per_sample_unit. Fixed by a fifth basis,
--      per_box. For Ivyronc, units_per_box is 1, so per_box and per_packaging_set are the same
--      number and nothing of his moves.
--   4. DBK holds several expiry dates for one material and he asked for a warning three months
--      ahead ("حاجات هتنتهي" — things that will expire). Fixed by
--      prodplan_stock_entries.expiry_date, which also makes a stock position lot-capable: the
--      current balance is now the newest row per (material, location, expiry_date), and Ivyronc's
--      rows all carry a NULL expiry, so for him that is one row per pair exactly as before.
--
-- ── What this migration deliberately does NOT do ────────────────────────────────────────────────
--
-- It does not arm anything. prodplan_settings.expiry_alarm_enabled ships false and
-- expiry_alarm_dry_run ships true, matching the reorder alarm's own fail-safe pair, and the email
-- template ships inactive. Arming is the owner's click, never a deployment.
--
-- It does not give Guamusin an overage. He asked for it empty until a real run measures one:
-- "ما ما نشغلش نفسنا بيها دلوقتي يخليها فاضية وحنبقى نحسبها بعد كده" — so every Guamusin
-- composition carries an explicit overage_pct of 0, and the buy list therefore equals the formula
-- to the digit. The consumption learner will propose a measured figure after the first run.
--
-- It gives the aluminium film NO composition row, because nobody has told us how much film a sachet
-- takes. That absence is the module's existing and deliberate way of saying "not measured" — a
-- seeded guess would put a number nobody verified into a purchase order.
--
-- Reverting: this migration is additive. To undo it,
--   delete from public.prodplan_stock_entries where location_id = (select id from public.prodplan_locations where code = 'DBK');
--   delete from public.prodplan_products where code = 'GUAMUSIN';  -- cascades its compositions and product_materials
--   delete from public.prodplan_locations where code = 'DBK';
-- and the added columns can be dropped; Ivyronc never reads any of them except
-- factory_location_id, which is backfilled to EGPI below.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. A product carries its own measure unit and its own factory ───────────────────────────────

alter table public.prodplan_products
  add column if not exists measure_unit text not null default 'ml';

alter table public.prodplan_products
  add column if not exists factory_location_id uuid references public.prodplan_locations (id);

alter table public.prodplan_products
  drop constraint if exists prodplan_products_measure_unit_check;

alter table public.prodplan_products
  add constraint prodplan_products_measure_unit_check
  check (measure_unit = any (array['ml'::text, 'g'::text]));

comment on column public.prodplan_products.measure_unit is
  'The unit the four geometry columns below are counted in: ml for a liquid, g for a powder. The arithmetic is unit-agnostic — only the words on the screen and in the Excel sheet change.';

-- 🔴 The geometry columns are named _ml for the one product that existed when they were created.
-- They hold MEASURE units, whose unit is measure_unit above: Guamusin's run_volume_ml of 100,000 is
-- 100 kg, not 100 litres. Renaming them would touch twelve columns across three tables and every
-- select string that names one, for no change in behaviour, so they are commented instead.
comment on column public.prodplan_products.run_volume_ml is
  'The FIXED size of one run, in measure_unit — 1,250,000 ml for Ivyronc, 100,000 g for Guamusin. Not necessarily millilitres despite the column name.';
comment on column public.prodplan_products.dose_ml is
  'One dose, in measure_unit — 5 ml of syrup, or one 5 g sachet. Not necessarily millilitres despite the column name.';
comment on column public.prodplan_products.good_unit_ml is
  'One saleable unit, in measure_unit. Not necessarily millilitres despite the column name.';
comment on column public.prodplan_products.sample_unit_ml is
  'One free medical sample, in measure_unit. Not necessarily millilitres despite the column name.';
comment on column public.prodplan_products.factory_location_id is
  'The location that IS this product''s factory, so "send to the factory" and "left after the run" mean something with more than one toll manufacturer. Null falls back to the first location flagged is_factory, which is how Ivyronc behaved before this column existed.';

-- ── 2. A fifth composition basis: per BOX ───────────────────────────────────────────────────────
-- A Guamusin carton holds 12 sachets, so it is consumed once per box and not once per sachet.
-- Ivyronc's units_per_box is 1, which makes per_box and per_packaging_set identical for every row
-- he has; none of his compositions is re-pointed here.

alter table public.prodplan_compositions
  drop constraint if exists prodplan_compositions_basis_check;

alter table public.prodplan_compositions
  add constraint prodplan_compositions_basis_check
  check (basis = any (array[
    'per_dose'::text,
    'per_packaging_set'::text,
    'per_good_unit'::text,
    'per_sample_unit'::text,
    'per_box'::text
  ]));

alter table public.prodplan_plan_lines
  drop constraint if exists prodplan_plan_lines_basis_check;

alter table public.prodplan_plan_lines
  add constraint prodplan_plan_lines_basis_check
  check (snap_basis = any (array[
    'per_dose'::text,
    'per_packaging_set'::text,
    'per_good_unit'::text,
    'per_sample_unit'::text,
    'per_box'::text
  ]));

-- ── 3. A product owns its own material list ─────────────────────────────────────────────────────
-- A material may belong to more than one product: citric acid anhydrous and the lemon flavour are
-- the same substance in both recipes, held in different places. A carton and a sticker are NOT —
-- Guamusin's artwork cannot go into an Ivyronc box, the same reason the leaflet was split in two on
-- 2026-10-06 — so those get their own rows.

create table if not exists public.prodplan_product_materials (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.prodplan_products (id) on delete cascade,
  material_id uuid not null references public.prodplan_materials (id) on delete cascade,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint prodplan_product_materials_unique unique (product_id, material_id)
);

comment on table public.prodplan_product_materials is
  'Which materials belong to which product, and the order they are listed in. Without this the planner loops over every material in the system, so a second product puts its whole raw-material list on the first product''s screen.';

create index if not exists prodplan_product_materials_product_idx
  on public.prodplan_product_materials (product_id, sort_order);

-- Everything that exists today belongs to Ivyronc, keeping the sort order it already had, so his
-- screen is identical the moment this lands — including the five materials with no composition,
-- whose absence is correct and must stay visible.
insert into public.prodplan_product_materials (product_id, material_id, sort_order)
select p.id, m.id, m.sort_order
from public.prodplan_products p
cross join public.prodplan_materials m
where p.code = 'IVYRONC'
on conflict (product_id, material_id) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'EGPI'
  and p.code = 'IVYRONC'
  and p.factory_location_id is null;

-- ── 4. A stock position carries an expiry, and is therefore lot-capable ─────────────────────────

alter table public.prodplan_stock_entries
  add column if not exists expiry_date date;

comment on column public.prodplan_stock_entries.expiry_date is
  'When this lot expires. Null means not recorded — which is every Ivyronc row, and which keeps one current balance per material and location exactly as before. With a date, the current balance is the newest row per (material_id, location_id, expiry_date), so one material can hold several lots at one place.';

create index if not exists prodplan_stock_entries_lot_idx
  on public.prodplan_stock_entries (material_id, location_id, expiry_date, as_of_date desc);

create index if not exists prodplan_stock_entries_expiry_idx
  on public.prodplan_stock_entries (expiry_date)
  where expiry_date is not null;

-- ── 5. The expiry warning: its own settings, its own fail-safe pair, its own events table ───────
-- Owner, 2026-10-08: "خانة الاكسبايري ديت مهمة جدا جدا جدا ... ويا ريت يدينا تنبيه قبل الاكسبايري
-- ديت بثلاث شهور علشان لو كده نعمل طلبيات مخصوص او نعمل تشغيلات مخصوص" — warn three months before,
-- so he can place a special order or schedule a special run and consume the material before it
-- dies. Three months is 90 days; the window is a setting, not a constant.

alter table public.prodplan_settings
  add column if not exists expiry_warn_days integer not null default 90;

alter table public.prodplan_settings
  add column if not exists expiry_alarm_enabled boolean not null default false;

alter table public.prodplan_settings
  add column if not exists expiry_alarm_dry_run boolean not null default true;

alter table public.prodplan_settings
  add column if not exists expiry_last_evaluated_on date;

alter table public.prodplan_settings
  add column if not exists expiry_last_sent_on date;

alter table public.prodplan_settings
  drop constraint if exists prodplan_settings_expiry_warn_days_check;

alter table public.prodplan_settings
  add constraint prodplan_settings_expiry_warn_days_check
  check (expiry_warn_days between 1 and 1095);

comment on column public.prodplan_settings.expiry_warn_days is
  'How many days before an expiry to start warning. 90 by default, which is the three months the owner asked for.';
comment on column public.prodplan_settings.expiry_alarm_enabled is
  'The expiry warning sends nothing unless this is explicitly true. It ships false: arming it is the owner''s click, not a deployment. Independent of alarm_enabled, which is the reorder alarm.';

create table if not exists public.prodplan_expiry_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.prodplan_products (id) on delete cascade,
  material_id uuid not null,
  unit_kind text not null,
  location_id uuid not null references public.prodplan_locations (id) on delete cascade,
  evaluated_on date not null,
  dry_run boolean not null,
  expiry_date date not null,
  days_remaining integer not null,
  held_qty numeric(24,6) not null,
  warn_days integer not null,
  email_sent boolean not null default false,
  email_error text,
  created_at timestamptz not null default now(),
  constraint prodplan_expiry_events_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  -- One verdict per lot per Cairo day per mode, so a second pass the same morning updates the
  -- figures instead of stacking a second row beside them. Keyed by the LOT, because two lots of one
  -- material at one place expire on different days and each deserves its own warning.
  constraint prodplan_expiry_events_unique
    unique (material_id, location_id, expiry_date, evaluated_on, dry_run),
  constraint prodplan_expiry_events_held_check check (held_qty >= 0),
  constraint prodplan_expiry_events_warn_days_check check (warn_days > 0),
  -- A dry run never sends. If this ever fails, the arming gates have been bypassed.
  constraint prodplan_expiry_events_dry_run_check check (dry_run = false or email_sent = false)
);

comment on table public.prodplan_expiry_events is
  'One row per expiring lot per evaluation. A dry run writes rows with email_sent = false, so the owner can read exactly what would have been sent before arming anything.';

create index if not exists prodplan_expiry_events_evaluated_idx
  on public.prodplan_expiry_events (evaluated_on desc, days_remaining);

-- ── Security: the two new tables match every other one — service-role only ──────────────────────
-- Visibility in this app is application-scoped, not RLS-scoped: these are read with the
-- service-role client after the module's own permission check. RLS is on and the browser roles hold
-- no grant at all, so a stray PostgREST call with the publishable key sees nothing.
do $$
declare
  t text;
begin
  foreach t in array array[
    'prodplan_product_materials',
    'prodplan_expiry_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- SEED — every figure below is a cell in xlsx/Guamusin-data-checked.xlsx
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── DBK, the second toll manufacturer ───────────────────────────────────────────────────────────
insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values ('DBK', 'مخزن المصنع — دي بي كيه', 'At the factory (DBK)', true, 30)
on conflict (code) do nothing;

-- ── Guamusin ────────────────────────────────────────────────────────────────────────────────────
-- One run is a FIXED 100 kg = 100,000 g = 20,000 sachets of 5 g. A sachet IS the dose and IS the
-- saleable unit, so dose, good unit and sample unit are all 5. Twelve sachets to a box, which makes
-- six runs exactly 10,000 boxes with nothing left over.
insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name, measure_unit,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box, notes
)
values (
  'GUAMUSIN',
  'جواموسين',
  'Guamusin',
  'DBK Pharma',
  'g',
  100000, 5, 5, 5, true, 12,
  'Powder in 5 g sachets, toll-manufactured by DBK. One run is a FIXED 100 kg = 20,000 sachets; 12 sachets to a box. No free samples, so sample_unit_ml is the sachet itself and is never used. Seeded 2026-10-08 from xlsx/Guamusin-data-checked.xlsx.'
)
on conflict (code) do nothing;

update public.prodplan_products p
set factory_location_id = l.id
from public.prodplan_locations l
where l.code = 'DBK'
  and p.code = 'GUAMUSIN'
  and p.factory_location_id is null;

-- ── The eleven materials Guamusin needs that did not exist ──────────────────────────────────────
-- Citric acid anhydrous and the lemon flavour are NOT here: they already exist for Ivyronc and are
-- the same substance, so Guamusin shares those two rows and holds its own stock of them at DBK.
-- The box and the sticker ARE here under their own codes, because Guamusin's artwork is not
-- interchangeable with Ivyronc's.
insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('PARACETAMOL_MICRO', 'باراسيتامول مطحون', 'Paracetamol micronized powder', 'mass', 'g', 'kg', 1000, false, null, 210, null),
  ('GUAIFENESIN', 'جوايفينيسين', 'Guaifenesin', 'mass', 'g', 'kg', 1000, true, 60, 220,
   'Imported — about two months of lead time, which is the one Guamusin material that has to be ordered early.'),
  ('PHENYLEPHRINE_HCL', 'فينيل إفرين هيدروكلوريد', 'Phenylephrine hydrochloride', 'mass', 'g', 'kg', 1000, false, null, 230, null),
  ('SUCROSE', 'سكروز', 'Sucrose', 'mass', 'g', 'kg', 1000, false, null, 240, null),
  ('SODIUM_CITRATE_ANH', 'سترات الصوديوم اللامائية', 'Sodium citrate anhydrous', 'mass', 'g', 'kg', 1000, false, null, 250, null),
  ('ASPARTAME', 'أسبرتام', 'Aspartame', 'mass', 'g', 'kg', 1000, false, null, 260, null),
  ('SACCHARIN_SODIUM', 'سكرين الصوديوم', 'Saccharine sodium', 'mass', 'g', 'kg', 1000, false, null, 270, null),
  ('QUINOLINE_YELLOW_E104', 'أصفر الكينولين E104', 'Quinoline yellow E104', 'mass', 'g', 'kg', 1000, false, null, 280, null),
  ('SACHET_FILM_ALU', 'فيلم الألومنيوم', 'Aluminum sachet film', 'mass', 'g', 'kg', 1000, false, null, 290,
   'Bought by the kilogram. NO composition row on purpose: nobody has told us how much film a sachet takes, so it has stock and a price but no requirement and never reaches the buy list. Packaging does not expire.'),
  ('BOX_GUAMUSIN_12', 'كرتونة 12 كيس', 'Carton box of 12', 'count', 'piece', 'piece', 1, false, null, 300,
   'Guamusin''s own box, holding 12 sachets. Not interchangeable with Ivyronc''s box, so it is its own material.'),
  ('STICKER_GUAMUSIN', 'ستيكر جواموسين', 'Guamusin sticker', 'count', 'piece', 'piece', 1, false, null, 310,
   'Guamusin''s own sticker artwork. Not interchangeable with Ivyronc''s sticker, so it is its own material.')
on conflict (code) do nothing;

-- ── Guamusin's material list, in the order the sheet numbers them ───────────────────────────────
insert into public.prodplan_product_materials (product_id, material_id, sort_order)
select p.id, m.id, v.sort_order
from public.prodplan_products p
join (values
  ('PARACETAMOL_MICRO', 10),
  ('GUAIFENESIN', 20),
  ('PHENYLEPHRINE_HCL', 30),
  ('SUCROSE', 40),
  ('SODIUM_CITRATE_ANH', 50),
  ('CITRIC_ACID_ANH', 60),
  ('ASPARTAME', 70),
  ('SACCHARIN_SODIUM', 80),
  ('LEMON_FLAVOUR', 90),
  ('QUINOLINE_YELLOW_E104', 100),
  ('SACHET_FILM_ALU', 110),
  ('BOX_GUAMUSIN_12', 120),
  ('STICKER_GUAMUSIN', 130)
) as v(code, sort_order) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'GUAMUSIN'
on conflict (product_id, material_id) do nothing;

-- ── The declaration of composition, per 5 g sachet ──────────────────────────────────────────────
-- Straight off his photographed Declaration of Composition, converted from milligrams per sachet to
-- GRAMS per dose, which is the base unit these materials are counted in.
--
-- The ten lines add to exactly 5.000000 g — one whole sachet. That total is the proof the figures
-- are right, and multiplied by the 120,000 doses in six runs it reproduces every "Need for 6 runs"
-- cell in his sheet to the digit: paracetamol 120 kg, guaifenesin 24, phenylephrine 1.464,
-- sucrose 389.016, sodium citrate 6, citric acid 1.2, aspartame 24, saccharine 10.2,
-- lemon flavour 24, quinoline yellow 0.12.
--
-- overage_pct is an explicit 0, not null: null would inherit the 3% default, and he asked for the
-- waste figure left empty until a real run measures one.
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, overage_pct, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, 'sato', 0, date '2026-10-08', v.note
from public.prodplan_products p
join (values
  ('PARACETAMOL_MICRO',     'per_dose', 1.000000, '1000 mg per sachet'),
  ('GUAIFENESIN',           'per_dose', 0.200000, '200 mg per sachet'),
  ('PHENYLEPHRINE_HCL',     'per_dose', 0.012200, '12.2 mg per sachet'),
  ('SUCROSE',               'per_dose', 3.241800, '3241.8 mg per sachet'),
  ('SODIUM_CITRATE_ANH',    'per_dose', 0.050000, '50 mg per sachet'),
  ('CITRIC_ACID_ANH',       'per_dose', 0.010000, '10 mg per sachet'),
  ('ASPARTAME',             'per_dose', 0.200000, '200 mg per sachet'),
  ('SACCHARIN_SODIUM',      'per_dose', 0.085000, '85 mg per sachet'),
  ('LEMON_FLAVOUR',         'per_dose', 0.200000, '200 mg per sachet'),
  ('QUINOLINE_YELLOW_E104', 'per_dose', 0.001000, '1 mg per sachet'),
  -- One box and one sticker per BOX of twelve sachets, which is 10,000 of each for six runs.
  ('BOX_GUAMUSIN_12',       'per_box',  1.000000, 'One box per 12 sachets'),
  ('STICKER_GUAMUSIN',      'per_box',  1.000000, 'One sticker per box')
) as v(code, basis, qty, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'GUAMUSIN'
on conflict (product_id, material_id, effective_from) do nothing;

-- ── Stock at DBK, as of 2026-10-08, from the sheet's "Stock at DBK" column ──────────────────────
-- Quantities are BASE units: grams for a mass, pieces for a count. The sheet is in kilograms, so a
-- mass is multiplied by 1,000.
--
-- Aspartame appears TWICE on purpose — 124.6 kg expiring 2027-05-09 and 23 kg expiring 2029-03-19.
-- That is the lot case the expiry_date column exists for, and the earlier date is what his warning
-- will fire on.
--
-- The aluminium film, the box and the sticker carry a NULL expiry because packaging does not expire
-- (owner, 2026-10-08: "package material no expiry date \Aluminum ,boxes & stickers").
--
-- Citric acid and saccharine sodium are seeded at ZERO with no expiry: the lots the sheet reports
-- are rejected or already past their date, so none of either is usable. A zero with a date on it is
-- a counted zero, which is a different statement from no row at all.
--
-- The sticker has NO row: its stock cell in the sheet is blank, and blank is not zero.
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, v.qty, date '2026-10-08', v.expiry, 'factory_report',
       'Seeded from xlsx/Guamusin-data-checked.xlsx'
from public.prodplan_locations l
join (values
  ('PARACETAMOL_MICRO',      14120.000000, date '2029-10-30'),
  ('GUAIFENESIN',           254610.000000, date '2027-06-24'),
  ('PHENYLEPHRINE_HCL',      14930.000000, date '2027-09-30'),
  ('SUCROSE',               207480.000000, date '2029-02-04'),
  ('SODIUM_CITRATE_ANH',      9460.000000, date '2028-07-31'),
  ('CITRIC_ACID_ANH',            0.000000, null),
  ('ASPARTAME',             124600.000000, date '2027-05-09'),
  ('SACCHARIN_SODIUM',           0.000000, null),
  ('LEMON_FLAVOUR',          41910.000000, date '2028-02-28'),
  ('QUINOLINE_YELLOW_E104',    790.000000, date '2029-12-09'),
  ('SACHET_FILM_ALU',       230950.000000, null),
  ('BOX_GUAMUSIN_12',        11060.000000, null)
) as v(code, qty, expiry) on true
join public.prodplan_materials m on m.code = v.code
where l.code = 'DBK';

-- Aspartame's second lot, same place, later date.
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, 23000.000000, date '2026-10-08', date '2029-03-19', 'factory_report',
       'Second lot — seeded from xlsx/Guamusin-data-checked.xlsx'
from public.prodplan_locations l
join public.prodplan_materials m on m.code = 'ASPARTAME'
where l.code = 'DBK';

-- ── Nothing in Sato's own store, counted ────────────────────────────────────────────────────────
-- Every "Stock at Sato store" cell in the sheet is zero: all of Guamusin's material sits at DBK. A
-- counted zero dated today is worth recording, because an absent row reads as "never counted".
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, expiry_date, source, note
)
select m.id, m.unit_kind, l.id, 0.000000, date '2026-10-08', null, 'own_count',
       'Nothing held here — seeded from xlsx/Guamusin-data-checked.xlsx'
from public.prodplan_locations l
join public.prodplan_product_materials pm on true
join public.prodplan_products p on p.id = pm.product_id and p.code = 'GUAMUSIN'
join public.prodplan_materials m on m.id = pm.material_id
where l.code = 'SATO_STORE'
  and not exists (
    select 1
    from public.prodplan_stock_entries existing
    where existing.material_id = m.id
      and existing.location_id = l.id
  );

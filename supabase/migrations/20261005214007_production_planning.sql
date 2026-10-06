-- production_planning
--
-- WHAT THIS CHANGES:
--   Thirteen new tables, all prefixed `prodplan_`, holding the Production Planner: the products we
--   have toll-manufactured, their run geometry, their bill of materials, where their raw materials
--   are stored, how much of each is held, what each costs, the planned orders, the finished runs
--   and the reorder alarms.
--
--     1.  prodplan_products          one row per manufactured product + its FIXED run geometry
--     2.  prodplan_materials         the raw-material and packaging master
--     3.  prodplan_compositions      the bill of materials, versioned by date, never deleted
--     4.  prodplan_locations         where stock sits (EGPI, Sato's own store)
--     5.  prodplan_stock_entries     APPEND-ONLY stock reports; current stock is the newest row
--     6.  prodplan_material_prices   APPEND-ONLY prices, one currency per row, exactly as typed
--     7.  prodplan_fx_rates          one row per date: the fetched USD→EGP rate and a manual override
--     8.  prodplan_settings          the singleton: default overage, cover threshold, 4 arming flags
--     9.  prodplan_plans             a planned production order, with its committed snapshot
--     10. prodplan_plan_lines        the per-material answer, materialised only when a plan commits
--     11. prodplan_runs              a finished run as the factory reported it
--     12. prodplan_run_materials     per-material actuals beside their own theory
--     13. prodplan_alarm_events      one row per reorder evaluation, dry run or real
--
--   Plus the seed: Ivyronc, its two locations, eleven materials, the seven composition lines we can
--   defend from the approved formula, the stock EGPI reported, and the settings row.
--
-- WHY:
--   Owner, 2026-10-05: Sato Pharma does not manufacture. Ivyronc is made under toll manufacturing
--   by EGPI and Sato supplies most of the raw materials, so before every production run somebody has
--   to work out how much of each material is needed, how much is already held at the factory and in
--   Sato's own store, how much to buy, how much to deliver, and what will be left afterwards. That
--   was being done by hand in a spreadsheet, one run at a time, and it lost its memory between runs.
--
--   Three things in here are the owner's own rules and are not implementation choices:
--
--   * THE RUN VOLUME IS FIXED. One Ivyronc run is 1,250 litres whatever is asked for. Free medical
--     samples (40 ml) are made OUT OF that same volume, so they REDUCE the number of 100 ml bottles
--     and RAISE total packaging consumption, because a sample still takes a full bottle, cap, carton
--     and sticker. Runs are whole only. That is why the geometry lives on the product row with
--     whole-dose-multiple CHECKs: it keeps the rounding in integer arithmetic, where it cannot drift.
--
--   * EVERY NUMBER IS EDITABLE FROM THE SCREEN AND STORED HERE. Nothing about a formula, a price, an
--     overage or a threshold is hard-coded in the application.
--
--   * STOCK AND PRICES ARE APPEND-ONLY. A stock report is a fact about a date, not a cell to
--     overwrite; `prodplan_stock_entries` keeps every report EGPI ever sent and the current figure is
--     a query over it. A row that can be edited is a row that can disagree with its own history.
--
--   Quantities are stored in BASE units — grams for a mass, pieces for a count — as numeric(24,6),
--   and the application reads them with `select("qty::text")` and parses to BigInt. PostgREST
--   serialises `numeric` as a JSON number, so without the cast the value is already a double before
--   our code sees it, and the figure on screen stops matching the formula in the Excel export.
--
--   Every table that carries a quantity also carries its own `unit_kind`, tied back with a composite
--   foreign key to (material_id, unit_kind). The duplication is deliberate: it lets each table hold a
--   local CHECK that a COUNT is a whole number, and it turns reinterpreting a stored `43` from
--   kilograms into pieces from a silent change of meaning into a foreign-key violation.
--
-- ROLLBACK:
--   drop table public.prodplan_alarm_events;
--   drop table public.prodplan_run_materials;
--   drop table public.prodplan_runs;
--   drop table public.prodplan_plan_lines;
--   drop table public.prodplan_plans;
--   drop table public.prodplan_settings;
--   drop table public.prodplan_fx_rates;
--   drop table public.prodplan_material_prices;
--   drop table public.prodplan_stock_entries;
--   drop table public.prodplan_locations;
--   drop table public.prodplan_compositions;
--   drop table public.prodplan_materials;
--   drop table public.prodplan_products;
--   -- SAFE in that order only; each is additive here and holds no row any other module reads.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is additive only: thirteen new tables and their seed. It touches no existing row.

begin;

-- ── 1. Products and their FIXED run geometry ─────────────────────────────────────────────────────
-- The geometry is on the product, not in code, because it is the one set of numbers every other
-- figure is derived from. The modulo CHECKs are what keep run rounding in integer arithmetic.
create table if not exists public.prodplan_products (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  name_en text not null,
  manufacturer_name text,
  run_volume_ml bigint not null,
  dose_ml integer not null,
  good_unit_ml integer not null,
  sample_unit_ml integer not null,
  whole_runs_only boolean not null default true,
  units_per_box integer not null default 1,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_products_code_key unique (code),
  constraint prodplan_products_code_check check (code = upper(btrim(code)) and char_length(code) between 2 and 40),
  constraint prodplan_products_name_ar_check check (char_length(btrim(name_ar)) between 1 and 160),
  constraint prodplan_products_name_en_check check (char_length(btrim(name_en)) between 1 and 160),
  constraint prodplan_products_run_volume_check check (run_volume_ml between 1 and 100000000),
  constraint prodplan_products_dose_check check (dose_ml between 1 and 1000),
  constraint prodplan_products_good_unit_check check (good_unit_ml between 1 and 100000),
  constraint prodplan_products_sample_unit_check check (sample_unit_ml between 1 and 100000),
  constraint prodplan_products_units_per_box_check check (units_per_box between 1 and 1000),
  -- Every volume on the row is a whole number of doses. Without this, good units per run and doses
  -- per bottle stop being integers and the whole engine has to carry fractions it cannot round.
  constraint prodplan_products_run_volume_dose_check check (run_volume_ml % dose_ml = 0),
  constraint prodplan_products_good_unit_dose_check check (good_unit_ml % dose_ml = 0),
  constraint prodplan_products_sample_unit_dose_check check (sample_unit_ml % dose_ml = 0),
  -- A run must hold at least one good unit when no samples are asked for.
  constraint prodplan_products_run_holds_unit_check check (run_volume_ml >= good_unit_ml)
);

comment on table public.prodplan_products is
  'One row per product manufactured for us under toll manufacturing, with its FIXED run geometry. Samples are made out of the same run volume, so they reduce good units and raise packaging.';
comment on column public.prodplan_products.run_volume_ml is
  'The FIXED volume of one production run, in millilitres. Owner rule: the run volume does not change with the quantity asked for.';
comment on column public.prodplan_products.sample_unit_ml is
  'Volume of one free medical sample. It consumes a FULL packaging set (bottle, cap, carton, sticker) despite holding less syrup.';
comment on column public.prodplan_products.whole_runs_only is
  'True when the factory can only make whole runs, so the planner rounds the run count UP and reports the surplus.';
comment on column public.prodplan_products.units_per_box is
  'Bottles in one box as the owner counts them. 1 for Ivyronc: his "boxes" and his "bottles" are the same number.';

-- ── 2. The material master ───────────────────────────────────────────────────────────────────────
-- Quantities everywhere are in BASE units (grams for a mass, pieces for a count). `display_unit`
-- and `base_per_display` are only how a number is shown and typed, and are editable.
create table if not exists public.prodplan_materials (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  name_en text not null,
  unit_kind text not null,
  base_unit text not null,
  display_unit text not null,
  base_per_display numeric(24,6) not null default 1,
  is_imported boolean not null default false,
  lead_time_days integer,
  min_order_qty numeric(24,6),
  purchase_increment numeric(24,6),
  reorder_cover_runs numeric(12,4),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The composite target every quantity-bearing child points at, so a stored quantity can never be
  -- reinterpreted from one unit kind into another.
  constraint prodplan_materials_id_unit_key unique (id, unit_kind),
  constraint prodplan_materials_code_key unique (code),
  constraint prodplan_materials_code_check check (code = upper(btrim(code)) and char_length(code) between 2 and 40),
  constraint prodplan_materials_name_ar_check check (char_length(btrim(name_ar)) between 1 and 160),
  constraint prodplan_materials_name_en_check check (char_length(btrim(name_en)) between 1 and 160),
  constraint prodplan_materials_unit_kind_check check (unit_kind = any (array['mass'::text, 'count'::text])),
  constraint prodplan_materials_base_unit_check check (
    (unit_kind = 'mass' and base_unit = 'g') or (unit_kind = 'count' and base_unit = 'piece')
  ),
  constraint prodplan_materials_display_unit_check check (char_length(btrim(display_unit)) between 1 and 20),
  constraint prodplan_materials_base_per_display_check check (base_per_display > 0),
  constraint prodplan_materials_lead_time_check check (lead_time_days is null or lead_time_days between 0 and 1095),
  constraint prodplan_materials_min_order_check check (min_order_qty is null or min_order_qty > 0),
  constraint prodplan_materials_increment_check check (purchase_increment is null or purchase_increment > 0),
  constraint prodplan_materials_cover_check check (reorder_cover_runs is null or reorder_cover_runs between 0 and 100),
  -- A count is whole at every point it is typed.
  constraint prodplan_materials_count_whole_check check (
    unit_kind <> 'count'
    or (
      base_per_display = trunc(base_per_display)
      and (min_order_qty is null or min_order_qty = trunc(min_order_qty))
      and (purchase_increment is null or purchase_increment = trunc(purchase_increment))
    )
  )
);

comment on table public.prodplan_materials is
  'Raw-material and packaging master. Quantities everywhere are in base units: grams for a mass, pieces for a count. display_unit/base_per_display are presentation only.';
comment on column public.prodplan_materials.base_per_display is
  'Base units in one display unit — 1000 for a material shown in kg, 1 for a piece. Changing it changes how a number is shown and typed, never what is stored.';
comment on column public.prodplan_materials.lead_time_days is
  'How long an order takes to arrive. The imported materials are about six months, which is why the reorder alarm exists at all.';
comment on column public.prodplan_materials.reorder_cover_runs is
  'Per-material override of the settings threshold: alarm when the stock held covers fewer than this many runs.';

-- ── 3. The bill of materials, versioned ──────────────────────────────────────────────────────────
-- Nothing here is ever deleted: a formula that was in force when a plan was committed has to stay
-- readable, so a change closes the old row with `effective_to` and opens a new one.
create table if not exists public.prodplan_compositions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.prodplan_products (id) on delete restrict,
  material_id uuid not null,
  unit_kind text not null,
  basis text not null,
  qty_per_basis numeric(24,6) not null,
  supplier text not null,
  overage_pct numeric(8,4),
  effective_from date not null default (now() at time zone 'Africa/Cairo')::date,
  effective_to date,
  notes text,
  created_by_hr_id text,
  created_by_login text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_compositions_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_compositions_unique_from unique (product_id, material_id, effective_from),
  constraint prodplan_compositions_basis_check check (
    basis = any (array['per_dose'::text, 'per_packaging_set'::text, 'per_good_unit'::text, 'per_sample_unit'::text])
  ),
  constraint prodplan_compositions_supplier_check check (
    supplier = any (array['sato'::text, 'factory'::text, 'shared_unsettled'::text])
  ),
  constraint prodplan_compositions_qty_check check (qty_per_basis > 0),
  constraint prodplan_compositions_overage_check check (overage_pct is null or overage_pct between 0 and 100),
  constraint prodplan_compositions_window_check check (effective_to is null or effective_to > effective_from),
  -- A packaging item is counted per set, and a count is whole.
  constraint prodplan_compositions_count_whole_check check (
    unit_kind <> 'count' or qty_per_basis = trunc(qty_per_basis)
  )
);

comment on table public.prodplan_compositions is
  'The bill of materials, versioned by date. A formula change closes the old row with effective_to and opens a new one; nothing is deleted, so a committed plan stays reproducible.';
comment on column public.prodplan_compositions.basis is
  'What qty_per_basis is measured against: per 5 ml dose, per packaging set (bottle+cap+carton+sticker, one per unit INCLUDING a sample), per good unit, or per sample unit.';
comment on column public.prodplan_compositions.supplier is
  'Who brings it: sato (we buy and deliver it), factory (EGPI brings it), shared_unsettled (not yet decided — it contributes NOTHING to a buy list until a human settles it).';
comment on column public.prodplan_compositions.overage_pct is
  'Per-material overage override. Null means the settings default. Replaced by the measured figure once runs are recorded.';

create index if not exists prodplan_compositions_product_idx
  on public.prodplan_compositions (product_id, material_id, effective_from desc);

-- ── 4. Where stock sits ──────────────────────────────────────────────────────────────────────────
-- A table rather than a CHECK constraint, because adding a second store is an owner edit on a
-- screen, not a migration.
create table if not exists public.prodplan_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  name_en text not null,
  is_factory boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_locations_code_key unique (code),
  constraint prodplan_locations_code_check check (code = upper(btrim(code)) and char_length(code) between 2 and 40),
  constraint prodplan_locations_name_ar_check check (char_length(btrim(name_ar)) between 1 and 120),
  constraint prodplan_locations_name_en_check check (char_length(btrim(name_en)) between 1 and 120)
);

comment on table public.prodplan_locations is
  'Where raw material is held. Cover is read across ALL active locations: material in Sato''s own store is owned just as much as material already at the factory.';

-- ── 5. Stock reports — APPEND-ONLY ───────────────────────────────────────────────────────────────
-- Current stock is  distinct on (material_id, location_id) order by as_of_date desc, created_at desc
-- — never a single mutable row, which could disagree with the history that produced it.
create table if not exists public.prodplan_stock_entries (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null,
  unit_kind text not null,
  location_id uuid not null references public.prodplan_locations (id) on delete restrict,
  qty numeric(24,6) not null,
  as_of_date date not null,
  source text not null default 'factory_report',
  note text,
  recorded_by_hr_id text,
  recorded_by_login text,
  created_at timestamptz not null default now(),
  constraint prodplan_stock_entries_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_stock_entries_qty_check check (qty >= 0),
  constraint prodplan_stock_entries_source_check check (
    source = any (array['factory_report'::text, 'own_count'::text, 'delivery'::text, 'adjustment'::text])
  ),
  constraint prodplan_stock_entries_count_whole_check check (
    unit_kind <> 'count' or qty = trunc(qty)
  )
);

comment on table public.prodplan_stock_entries is
  'APPEND-ONLY stock reports. One row is "this material, at this location, was this much on this date". The current figure is the newest row; nothing is ever overwritten.';
comment on column public.prodplan_stock_entries.as_of_date is
  'The date the quantity was true, which is NOT the date it was typed in. Two reports for one date are resolved by created_at.';

create index if not exists prodplan_stock_entries_current_idx
  on public.prodplan_stock_entries (material_id, location_id, as_of_date desc, created_at desc);

-- ── 6. Prices — APPEND-ONLY, one currency per row ────────────────────────────────────────────────
-- Exactly what was typed, in the currency it was typed in. There is deliberately NO second,
-- derived-currency column: two stored currencies for one price are two truths, and the moment the
-- exchange rate moves one of them is wrong with nothing to say so. The other currency is derived at
-- read time from the rate in force.
create table if not exists public.prodplan_material_prices (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null,
  unit_kind text not null,
  currency text not null,
  price_per_display_unit numeric(18,6) not null,
  effective_from date not null default (now() at time zone 'Africa/Cairo')::date,
  supplier_name text,
  note text,
  recorded_by_hr_id text,
  recorded_by_login text,
  created_at timestamptz not null default now(),
  constraint prodplan_material_prices_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_material_prices_unique_from unique (material_id, currency, effective_from),
  constraint prodplan_material_prices_currency_check check (currency = any (array['USD'::text, 'EGP'::text])),
  constraint prodplan_material_prices_price_check check (price_per_display_unit > 0)
);

comment on table public.prodplan_material_prices is
  'APPEND-ONLY prices, one currency per row, stored per DISPLAY unit exactly as typed. No derived-currency column: the other currency comes from the FX rate in force at read time.';

create index if not exists prodplan_material_prices_current_idx
  on public.prodplan_material_prices (material_id, currency, effective_from desc);

-- ── 7. The USD→EGP rate, one row per date ────────────────────────────────────────────────────────
-- The fetched rate and a manual override are SEPARATE columns, and `fetch_ok` is persisted rather
-- than inferred from a null. A failed fetch writes fetch_ok = false and NEVER overwrites a good rate
-- with a null, which is how a cost silently became zero in a system that inferred it.
create table if not exists public.prodplan_fx_rates (
  rate_date date primary key,
  fetched_usd_to_egp numeric(14,6),
  fetch_ok boolean not null default false,
  fetch_source text,
  fetch_error text,
  fetched_at timestamptz,
  manual_usd_to_egp numeric(14,6),
  manual_note text,
  manual_by_hr_id text,
  manual_by_login text,
  manual_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_fx_rates_fetched_check check (fetched_usd_to_egp is null or fetched_usd_to_egp > 0),
  constraint prodplan_fx_rates_manual_check check (manual_usd_to_egp is null or manual_usd_to_egp > 0),
  -- fetch_ok is a claim that a rate arrived, so it cannot be true with nothing to show.
  constraint prodplan_fx_rates_ok_check check (fetch_ok = false or fetched_usd_to_egp is not null)
);

comment on table public.prodplan_fx_rates is
  'One row per date. The effective rate is manual_usd_to_egp when set, otherwise fetched_usd_to_egp — derived at read, never stored as a third column.';
comment on column public.prodplan_fx_rates.fetch_ok is
  'Persisted, not inferred. A failed fetch writes false and leaves any good rate alone.';

-- ── 8. Settings — one row, and the four arming flags ─────────────────────────────────────────────
-- Every column carries a DB CHECK mirroring the UI validation, so a bad value cannot reach the cron
-- through an API the UI did not write.
create table if not exists public.prodplan_settings (
  id smallint primary key default 1,
  default_overage_pct numeric(8,4) not null default 3,
  reorder_cover_runs numeric(12,4) not null default 1,
  alarm_enabled boolean not null default false,
  alarm_dry_run boolean not null default true,
  fx_fetch_enabled boolean not null default false,
  fx_fetch_dry_run boolean not null default true,
  fx_fallback_usd_to_egp numeric(14,6),
  alarm_last_evaluated_on date,
  alarm_last_sent_on date,
  updated_by_hr_id text,
  updated_by_login text,
  updated_at timestamptz not null default now(),
  constraint prodplan_settings_singleton_check check (id = 1),
  constraint prodplan_settings_overage_check check (default_overage_pct between 0 and 100),
  constraint prodplan_settings_cover_check check (reorder_cover_runs between 0 and 100),
  constraint prodplan_settings_fallback_check check (fx_fallback_usd_to_egp is null or fx_fallback_usd_to_egp > 0)
);

comment on table public.prodplan_settings is
  'The single settings row. Two independent arming pairs: alarm_enabled/alarm_dry_run for the reorder email, fx_fetch_enabled/fx_fetch_dry_run for the daily rate. Both ship OFF and in dry run.';
comment on column public.prodplan_settings.alarm_enabled is
  'Owner arms the reorder email here. False means the cron answers "skipped: disabled" — which is deliberately NOT the same answer as "0 sent".';
comment on column public.prodplan_settings.alarm_dry_run is
  'True records every alarm it would have raised and sends nothing. The loader reads it fail-safe (anything but an explicit false is a dry run).';

-- ── 9. A planned production order ────────────────────────────────────────────────────────────────
-- A draft recomputes live from current values. Committing freezes the geometry, the overage and the
-- FX rate into the snap_* columns, so a cost worked out in January still reproduces in June.
create table if not exists public.prodplan_plans (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.prodplan_products (id) on delete restrict,
  title text not null,
  request_mode text not null default 'total_boxes',
  requested_qty bigint not null,
  sample_units bigint not null default 0,
  status text not null default 'draft',
  snap_overage_pct numeric(8,4),
  snap_run_volume_ml bigint,
  snap_dose_ml integer,
  snap_good_unit_ml integer,
  snap_sample_unit_ml integer,
  snap_units_per_box integer,
  snap_runs bigint,
  snap_good_units bigint,
  snap_packaging_sets bigint,
  snap_fx_usd_to_egp numeric(14,6),
  snap_fx_rate_date date,
  notes text,
  created_by_hr_id text,
  created_by_login text not null,
  committed_at timestamptz,
  committed_by_hr_id text,
  committed_by_login text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_plans_title_check check (char_length(btrim(title)) between 1 and 160),
  constraint prodplan_plans_mode_check check (
    request_mode = any (array['total_boxes'::text, 'good_units'::text, 'runs'::text])
  ),
  constraint prodplan_plans_requested_check check (requested_qty > 0),
  constraint prodplan_plans_samples_check check (sample_units >= 0),
  constraint prodplan_plans_status_check check (
    status = any (array['draft'::text, 'committed'::text, 'cancelled'::text])
  ),
  -- A committed plan carries its whole snapshot or it is not reproducible, which is the only reason
  -- the snapshot exists.
  constraint prodplan_plans_commit_snapshot_check check (
    status <> 'committed'
    or (
      snap_overage_pct is not null
      and snap_run_volume_ml is not null
      and snap_dose_ml is not null
      and snap_good_unit_ml is not null
      and snap_sample_unit_ml is not null
      and snap_units_per_box is not null
      and snap_runs is not null
      and snap_good_units is not null
      and snap_packaging_sets is not null
      and committed_at is not null
      and committed_by_login is not null
    )
  ),
  constraint prodplan_plans_cancelled_check check ((status = 'cancelled') = (cancelled_at is not null))
);

comment on table public.prodplan_plans is
  'A planned production order. request_mode says what requested_qty means — total boxes (the owner''s usual), good units only, or a run count. Committing freezes the snap_* snapshot.';
comment on column public.prodplan_plans.requested_qty is
  'What was asked for, read through request_mode. total_boxes is the TOTAL including samples: asking for 100,000 with 10,000 samples means 90,000 good units and 10,000 samples, not 110,000 boxes.';
comment on column public.prodplan_plans.snap_packaging_sets is
  'Good units PLUS samples: a sample holds less syrup but consumes a full bottle, cap, carton and sticker.';

create index if not exists prodplan_plans_product_idx
  on public.prodplan_plans (product_id, created_at desc);

-- ── 10. The per-material answer, materialised ONLY on commit ─────────────────────────────────────
-- A draft has no rows here; its lines are computed live. `snap_supplier` cannot be
-- 'shared_unsettled', so the database enforces that the question of who brings a material was
-- answered before anything was ordered against it.
create table if not exists public.prodplan_plan_lines (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.prodplan_plans (id) on delete cascade,
  material_id uuid not null,
  unit_kind text not null,
  snap_supplier text not null,
  snap_basis text not null,
  snap_qty_per_basis numeric(24,6) not null,
  snap_overage_pct numeric(8,4) not null,
  needed_qty numeric(24,6) not null,
  held_qty numeric(24,6) not null,
  to_buy_qty numeric(24,6) not null,
  to_deliver_qty numeric(24,6) not null,
  balance_after_qty numeric(24,6) not null,
  snap_price_currency text,
  snap_price_per_display_unit numeric(18,6),
  snap_cost_usd numeric(18,4),
  snap_cost_egp numeric(18,4),
  created_at timestamptz not null default now(),
  constraint prodplan_plan_lines_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_plan_lines_unique unique (plan_id, material_id),
  -- The one place 'shared_unsettled' is refused: a committed order says who brings each material.
  constraint prodplan_plan_lines_supplier_check check (
    snap_supplier = any (array['sato'::text, 'factory'::text])
  ),
  constraint prodplan_plan_lines_basis_check check (
    snap_basis = any (array['per_dose'::text, 'per_packaging_set'::text, 'per_good_unit'::text, 'per_sample_unit'::text])
  ),
  constraint prodplan_plan_lines_qty_check check (snap_qty_per_basis > 0),
  constraint prodplan_plan_lines_overage_check check (snap_overage_pct between 0 and 100),
  constraint prodplan_plan_lines_needed_check check (needed_qty >= 0),
  constraint prodplan_plan_lines_held_check check (held_qty >= 0),
  constraint prodplan_plan_lines_to_buy_check check (to_buy_qty >= 0),
  constraint prodplan_plan_lines_to_deliver_check check (to_deliver_qty >= 0),
  constraint prodplan_plan_lines_currency_check check (
    snap_price_currency is null or snap_price_currency = any (array['USD'::text, 'EGP'::text])
  ),
  constraint prodplan_plan_lines_count_whole_check check (
    unit_kind <> 'count'
    or (
      needed_qty = trunc(needed_qty)
      and held_qty = trunc(held_qty)
      and to_buy_qty = trunc(to_buy_qty)
      and to_deliver_qty = trunc(to_deliver_qty)
    )
  )
);

comment on table public.prodplan_plan_lines is
  'The per-material answer for a COMMITTED plan only. A draft computes its lines live, so there is never a stored line that disagrees with current settings.';

-- ── 11. A finished run as the factory reported it ────────────────────────────────────────────────
-- This is what turns the 3% overage from a guess into a measured figure. A mistyped run is EXCLUDED
-- from learning rather than deleted, so the report of what the factory said stays intact.
create table if not exists public.prodplan_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.prodplan_products (id) on delete restrict,
  plan_id uuid references public.prodplan_plans (id) on delete set null,
  run_label text not null,
  runs_count integer not null default 1,
  actual_good_units bigint not null,
  actual_sample_units bigint not null default 0,
  snap_run_volume_ml bigint not null,
  snap_dose_ml integer not null,
  snap_good_unit_ml integer not null,
  snap_sample_unit_ml integer not null,
  produced_on date not null,
  is_excluded_from_learning boolean not null default false,
  exclusion_reason text,
  notes text,
  recorded_by_hr_id text,
  recorded_by_login text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prodplan_runs_label_check check (char_length(btrim(run_label)) between 1 and 120),
  constraint prodplan_runs_count_check check (runs_count between 1 and 1000),
  constraint prodplan_runs_good_units_check check (actual_good_units >= 0),
  constraint prodplan_runs_samples_check check (actual_sample_units >= 0),
  constraint prodplan_runs_volume_check check (snap_run_volume_ml > 0),
  constraint prodplan_runs_dose_check check (snap_dose_ml > 0),
  constraint prodplan_runs_good_unit_check check (snap_good_unit_ml > 0),
  constraint prodplan_runs_sample_unit_check check (snap_sample_unit_ml > 0),
  -- An exclusion always says why, so the next reader knows it was a judgement and not a slip.
  constraint prodplan_runs_exclusion_check check (
    is_excluded_from_learning = false or char_length(btrim(coalesce(exclusion_reason, ''))) > 0
  )
);

comment on table public.prodplan_runs is
  'A finished production run as the factory reported it. Recording runs is what replaces the estimated overage with a measured one. A bad row is excluded from learning, never deleted.';
comment on column public.prodplan_runs.is_excluded_from_learning is
  'Set when the figures are known to be wrong. The row stays — it is still the record of what was reported — but the learner ignores it.';

create index if not exists prodplan_runs_product_idx
  on public.prodplan_runs (product_id, produced_on desc);

-- ── 12. Per-material actuals beside their own theory ─────────────────────────────────────────────
-- `consumed_qty` is GENERATED: it is opening + delivered − closing by definition, and a stored
-- answer that can be typed independently of its own inputs is a third number to disagree with them.
create table if not exists public.prodplan_run_materials (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.prodplan_runs (id) on delete cascade,
  material_id uuid not null,
  unit_kind text not null,
  opening_qty numeric(24,6) not null,
  delivered_qty numeric(24,6) not null default 0,
  closing_qty numeric(24,6) not null,
  consumed_qty numeric(24,6) generated always as (opening_qty + delivered_qty - closing_qty) stored,
  theoretical_qty numeric(24,6),
  note text,
  created_at timestamptz not null default now(),
  constraint prodplan_run_materials_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_run_materials_unique unique (run_id, material_id),
  constraint prodplan_run_materials_opening_check check (opening_qty >= 0),
  constraint prodplan_run_materials_delivered_check check (delivered_qty >= 0),
  constraint prodplan_run_materials_closing_check check (closing_qty >= 0),
  -- You cannot end with more than you started with plus what arrived: that is a typo, not a run.
  constraint prodplan_run_materials_balance_check check (closing_qty <= opening_qty + delivered_qty),
  constraint prodplan_run_materials_theoretical_check check (theoretical_qty is null or theoretical_qty >= 0),
  constraint prodplan_run_materials_count_whole_check check (
    unit_kind <> 'count'
    or (
      opening_qty = trunc(opening_qty)
      and delivered_qty = trunc(delivered_qty)
      and closing_qty = trunc(closing_qty)
    )
  )
);

comment on table public.prodplan_run_materials is
  'What one run actually consumed of each material, beside what the model said it would. consumed_qty is a generated column so it cannot drift from its own inputs.';
comment on column public.prodplan_run_materials.theoretical_qty is
  'What the model predicted for this run, snapshotted at the moment the run was recorded. The gap between this and consumed_qty is the measured overage.';

create index if not exists prodplan_run_materials_material_idx
  on public.prodplan_run_materials (material_id, run_id);

-- ── 13. Reorder evaluations, dry run or real ─────────────────────────────────────────────────────
-- A dry run still writes rows. That is the whole point: the owner can see exactly what WOULD have
-- been emailed before he arms anything.
create table if not exists public.prodplan_alarm_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.prodplan_products (id) on delete cascade,
  material_id uuid not null,
  unit_kind text not null,
  evaluated_on date not null,
  dry_run boolean not null,
  cover_runs numeric(14,4) not null,
  threshold_runs numeric(14,4) not null,
  held_qty numeric(24,6) not null,
  needed_per_run_qty numeric(24,6) not null,
  lead_time_days integer,
  email_sent boolean not null default false,
  email_error text,
  created_at timestamptz not null default now(),
  constraint prodplan_alarm_events_material_fk
    foreign key (material_id, unit_kind)
    references public.prodplan_materials (id, unit_kind)
    on delete restrict,
  constraint prodplan_alarm_events_unique unique (material_id, evaluated_on, dry_run),
  constraint prodplan_alarm_events_cover_check check (cover_runs >= 0),
  constraint prodplan_alarm_events_threshold_check check (threshold_runs >= 0),
  constraint prodplan_alarm_events_held_check check (held_qty >= 0),
  constraint prodplan_alarm_events_per_run_check check (needed_per_run_qty > 0),
  -- A dry run never sends. If this ever fails, the arming gates have been bypassed.
  constraint prodplan_alarm_events_dry_run_check check (dry_run = false or email_sent = false)
);

comment on table public.prodplan_alarm_events is
  'One row per material per reorder evaluation. A dry run writes rows with email_sent = false, so the owner can read exactly what would have been sent before arming anything.';

-- ── Security: every table service-role only ──────────────────────────────────────────────────────
-- Visibility in this app is application-scoped, not RLS-scoped: these are read with the
-- service-role client after the module's own permission check. RLS is on and the browser roles hold
-- no grant at all, so a stray PostgREST call with the publishable key sees nothing.
do $$
declare
  t text;
begin
  foreach t in array array[
    'prodplan_products',
    'prodplan_materials',
    'prodplan_compositions',
    'prodplan_locations',
    'prodplan_stock_entries',
    'prodplan_material_prices',
    'prodplan_fx_rates',
    'prodplan_settings',
    'prodplan_plans',
    'prodplan_plan_lines',
    'prodplan_runs',
    'prodplan_run_materials',
    'prodplan_alarm_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ── Seed ─────────────────────────────────────────────────────────────────────────────────────────
-- Only what can be defended from the approved formula and the factory's own report. A material we
-- know exists but have no verified quantity for is seeded WITHOUT a composition row, so the screen
-- says "composition not entered" rather than showing a number nobody measured.

insert into public.prodplan_settings (id)
values (1)
on conflict (id) do nothing;

insert into public.prodplan_products (
  code, name_ar, name_en, manufacturer_name,
  run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box, notes
)
values (
  'IVYRONC',
  'آيفيرونك',
  'Ivyronc',
  'EGPI — Egyptian Group for Pharmaceutical Industries',
  1250000, 5, 100, 40, true, 1,
  'Herbal cough syrup, toll-manufactured by EGPI. One run is a FIXED 1,250 L = 250,000 doses of 5 ml. Samples are made out of that same volume.'
)
on conflict (code) do nothing;

insert into public.prodplan_locations (code, name_ar, name_en, is_factory, sort_order)
values
  ('EGPI', 'مخزن المصنع — إي جي بي آي', 'At the factory (EGPI)', true, 10),
  ('SATO_STORE', 'مخزن ساتو', 'Sato''s own store', false, 20)
on conflict (code) do nothing;

insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('IVY_EXTRACT',      'مستخلص أوراق اللبلاب', 'Ivy leaf extract',      'mass',  'g',     'kg',    1000, true,  180, 10, 'The active ingredient, imported. Roughly six months of lead time, which is the reason the reorder alarm exists.'),
  ('SORBITOL',         'سوربيتول',             'Sorbitol',              'mass',  'g',     'kg',    1000, false, 30,  20, 'The largest quantity after the ivy extract.'),
  ('POTASSIUM_SORBATE','سوربات البوتاسيوم',    'Potassium sorbate',     'mass',  'g',     'kg',    1000, false, 30,  30, 'Preservative. Who brings it is NOT yet settled with the factory.'),
  ('XANTHAN_GUM',      'صمغ الزانثان',         'Xanthan gum',           'mass',  'g',     'kg',    1000, false, 30,  40, 'Who brings it is NOT yet settled with the factory, and the quantity has not been confirmed.'),
  ('CITRIC_ACID_ANH',  'حمض الستريك اللامائي', 'Citric acid anhydrous', 'mass',  'g',     'kg',    1000, false, 30,  50, 'Brought by the factory. Quantity not confirmed, so no composition row is seeded.'),
  ('LEMON_FLAVOUR',    'منكِّه الليمون',        'Lemon flavour',         'mass',  'g',     'kg',    1000, false, 60,  60, 'The approved formula says vanillin; the carton says lemon. Unsettled, and the quantity is unconfirmed.'),
  ('CARTON',           'كرتونة',               'Carton',                'count', 'piece', 'piece', 1,    false, 21,  70, 'One per packaging set — including every sample.'),
  ('STICKER',          'ستيكر',                'Sticker',               'count', 'piece', 'piece', 1,    false, 21,  80, 'One per packaging set — including every sample.'),
  ('BOTTLE',           'زجاجة',                'Bottle',                'count', 'piece', 'piece', 1,    false, 30,  90, 'Brought by the factory. A 40 ml sample still takes a whole bottle.'),
  ('CAP',              'غطاء',                 'Cap',                   'count', 'piece', 'piece', 1,    false, 30,  100, 'Brought by the factory.'),
  ('LEAFLET',          'البروشور الداخلي',     'Leaflet',               'count', 'piece', 'piece', 1,    false, 21,  110, 'Whether the leaflet is tracked here is not settled, so no composition row is seeded. Its stock at the factory is recorded.'),
  ('ALUMINIUM_SEAL',   'سيل ألومنيوم',         'Aluminium seal',        'count', 'piece', 'piece', 1,    false, 30,  120, 'Not settled, and it does not appear in the factory''s stock report.')
on conflict (code) do nothing;

-- The seven composition lines that come straight out of the approved formula and the batch
-- arithmetic the owner has already checked:
--   ivy extract       35 mg per 5 ml dose  → 250,000 doses × 0.035 g = 8.75 kg a run
--   sorbitol          500 kg a run         → 500,000 g / 250,000 doses = 2 g per dose
--   potassium sorbate 1.675 kg a run       → 0.0067 g per dose
--   carton / sticker / bottle / cap        1 piece per packaging set
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, c.basis, c.qty, c.supplier, date '2026-01-01', c.notes
from public.prodplan_products p
cross join (
  values
    ('IVY_EXTRACT',      'per_dose',          0.035::numeric, 'sato',             '35 mg per 5 ml dose = 8.75 kg a run.'),
    ('SORBITOL',         'per_dose',          2::numeric,     'sato',             '500 kg a run across 250,000 doses.'),
    ('POTASSIUM_SORBATE','per_dose',          0.0067::numeric,'shared_unsettled', '1.675 kg a run. Who brings it is not settled, so it contributes nothing to a buy list yet.'),
    ('CARTON',           'per_packaging_set', 1::numeric,     'sato',             'One per unit, samples included.'),
    ('STICKER',          'per_packaging_set', 1::numeric,     'sato',             'One per unit, samples included.'),
    ('BOTTLE',           'per_packaging_set', 1::numeric,     'factory',          'One per unit, samples included. Brought by the factory.'),
    ('CAP',              'per_packaging_set', 1::numeric,     'factory',          'One per unit, samples included. Brought by the factory.')
) as c (code, basis, qty, supplier, notes)
join public.prodplan_materials m on m.code = c.code
where p.code = 'IVYRONC'
on conflict (product_id, material_id, effective_from) do nothing;

-- The stock EGPI reported in the batch-order correspondence. Quantities are in BASE units, so a
-- material shown in kg is seeded in grams. The report's own date was never recorded, so as_of_date
-- is the day these figures were taken into the model and the note says so.
insert into public.prodplan_stock_entries (
  material_id, unit_kind, location_id, qty, as_of_date, source, note
)
select m.id, m.unit_kind, l.id, s.qty, date '2026-10-05', 'factory_report', s.note
from (
  values
    ('IVY_EXTRACT', 43000::numeric,  '43 kg, as reported by EGPI. The report''s own date was not recorded.'),
    ('SORBITOL',    299000::numeric, '200 + 99 = 299 kg, as reported by EGPI.'),
    ('CARTON',      13850::numeric,  'As reported by EGPI.'),
    ('STICKER',     65850::numeric,  'As reported by EGPI.'),
    ('LEAFLET',     78250::numeric,  'Old leaflet 68,250 across two lots plus new leaflet 10,000, as reported by EGPI. They are not the same item; split this into two materials once the owner decides whether the leaflet is tracked.')
) as s (code, qty, note)
join public.prodplan_materials m on m.code = s.code
cross join public.prodplan_locations l
where l.code = 'EGPI'
on conflict do nothing;

commit;

-- Verify (catalog, not the ledger):
--   select relname, relrowsecurity from pg_class
--    where relname like 'prodplan_%' order by relname;
--   select table_name, grantee, privilege_type from information_schema.role_table_grants
--    where table_name like 'prodplan_%' and grantee in ('anon','authenticated','service_role')
--    order by table_name, grantee;
--   select code, run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml from public.prodplan_products;
--   select m.code, c.basis, c.qty_per_basis, c.supplier
--     from public.prodplan_compositions c join public.prodplan_materials m on m.id = c.material_id
--    order by m.code;
--   select m.code, s.qty, s.as_of_date from public.prodplan_stock_entries s
--     join public.prodplan_materials m on m.id = s.material_id order by m.code;
--   -- one run, zero samples:  (1250000 - 0*40)/100 = 12,500 good units, 12,500 packaging sets
--   -- one run, 10,000 samples: (1250000 - 400000)/100 = 8,500 good units, 18,500 packaging sets

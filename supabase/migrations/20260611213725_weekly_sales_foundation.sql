-- ─────────────────────────────────────────────────────────────────────────────
-- Weekly Sales module — foundation tables.
--
-- A COMPLETELY SEPARATE module from the monthly Source-of-Sales pipeline
-- (source_of_sales_*). Distributors send a weekly "Sales & Stock" export; we
-- recognise each distributor's template, recompute sales value from the product
-- master (qty × factory_price × (1 - discount) — the sheet's own value is
-- ignored), capture STOCK AS UNITS ONLY (no stock value anywhere), and key every
-- batch by the week-start date carried in the sheet's first column.
--
-- These tables share the region/product/distributor MASTERS (source_of_sales_*)
-- by code only; no monthly fact rows are read or written here.
--
-- RLS: enabled, NO public policies. All access is server-side via the service
-- role (getSupabaseAdmin), gated by the application `weekly_sales` permission in
-- the route handlers — mirroring the source_of_sales_* posture.
-- ─────────────────────────────────────────────────────────────────────────────

-- Upload header: one row per uploaded weekly file (per distributor per week).
create table if not exists public.weekly_sales_batches (
  id uuid primary key default gen_random_uuid(),
  distributor_code text not null,
  distributor_name text not null,
  template_key text not null,
  file_name text not null,
  sheet_name text not null default '',
  -- The canonical week, taken from the Date column INSIDE the sheet (never the
  -- file name). One week per file.
  week_start date,
  status text not null check (status in ('blocked', 'validated')),
  total_rows integer not null default 0,
  importable_rows integer not null default 0,
  failed_rows integer not null default 0,
  warning_rows integer not null default 0,
  total_sales_qty numeric(18, 6) not null default 0,
  total_bonus_qty numeric(18, 6) not null default 0,
  total_sales_value numeric(18, 6) not null default 0,
  -- Stock is units only — there is deliberately NO total_stock_value column.
  total_stock_qty numeric(18, 6) not null default 0,
  blocking_reasons text[] not null default '{}',
  uploaded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists weekly_sales_batches_status_week_idx
  on public.weekly_sales_batches (status, week_start);
create index if not exists weekly_sales_batches_created_idx
  on public.weekly_sales_batches (created_at desc);
create index if not exists weekly_sales_batches_distributor_idx
  on public.weekly_sales_batches (distributor_code);

-- Only ONE validated batch may exist per distributor per week — re-uploading the
-- same week is blocked at the app layer, and enforced here as a hard guarantee so
-- a week can never be double-counted. Blocked batches are not constrained.
create unique index if not exists weekly_sales_batches_validated_week_uidx
  on public.weekly_sales_batches (distributor_code, week_start)
  where status = 'validated';

-- Fact rows: one row per branch × product × week (the weekly sheet's grain).
create table if not exists public.weekly_sales_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.weekly_sales_batches (id) on delete cascade,
  row_number integer not null,
  week_start date,
  distributor_code text not null,
  distributor_name text not null,
  region_code text not null default '',
  region_name text not null default '',
  -- The distributor's own depot/branch (e.g. "El Minya Branch"). New dimension —
  -- drives stock-by-branch and zero-sales-branch views. Not a brick/area.
  branch_code text not null default '',
  branch_name text not null default '',
  -- The distributor's SKU (e.g. Ibn Sina item code). product_code is OUR master code.
  item_code text not null default '',
  product_code text not null default '',
  product_name text not null default '',
  official_line text not null default '',
  sales_qty numeric(18, 6) not null default 0,
  bonus_qty numeric(18, 6) not null default 0,
  discount numeric(18, 6) not null default 0,
  -- Recomputed: qty × factory_price × (1 - discount). The sheet's value is ignored.
  sales_value numeric(18, 6) not null default 0,
  -- Stock units only (no stock value).
  stock_qty numeric(18, 6) not null default 0,
  validation_state text not null check (validation_state in ('valid', 'warning', 'failed')),
  validation_issues jsonb not null default '[]'::jsonb,
  raw_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create index if not exists weekly_sales_rows_batch_idx on public.weekly_sales_rows (batch_id);
create index if not exists weekly_sales_rows_week_idx on public.weekly_sales_rows (week_start);
create index if not exists weekly_sales_rows_region_idx on public.weekly_sales_rows (region_code);
create index if not exists weekly_sales_rows_product_idx on public.weekly_sales_rows (product_code);
create index if not exists weekly_sales_rows_distributor_idx on public.weekly_sales_rows (distributor_code);

-- Lock both tables down: RLS on, no policies → only the service role reaches them.
alter table public.weekly_sales_batches enable row level security;
alter table public.weekly_sales_rows enable row level security;

comment on table public.weekly_sales_batches is
  'Weekly Sales module upload headers (separate from source_of_sales_*). One validated batch per distributor per week.';
comment on table public.weekly_sales_rows is
  'Weekly Sales fact rows at branch x product x week grain. Sales value recomputed from factory price; stock is units only.';

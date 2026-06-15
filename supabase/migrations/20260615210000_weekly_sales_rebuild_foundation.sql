-- ─────────────────────────────────────────────────────────────────────────────
-- Weekly Sales REBUILD — additive foundation (PR 1 of the rebuild).
--
-- This migration is ADDITIVE ONLY: it creates the two new mapping tables and adds
-- net/return columns. It performs NO drops and NO data wipe. The destructive steps
-- (TRUNCATE weekly_sales_rows/_batches, DROP legacy discount/bonus columns, DROP the
-- old weekly_sales_pos_region_mappings table) are deferred to a later PR and only run
-- AFTER the new parser stops writing those columns — so the still-live OLD parser is
-- never broken by this migration.
--
-- New model:
--   • weekly_sales_product_aliases    — distributor SKU/name -> Source-of-Sales master product_code
--   • weekly_sales_branch_region_map  — per-distributor branch/outlet -> master region (controlled vocab)
--   • weekly_sales_rows.{return_qty,net_qty} + weekly_sales_batches.{total_return_qty,total_net_qty}
--
-- RLS: enabled, NO policies → service-role only (mirrors weekly_sales_batches/_rows/
-- _product_scope, foundation migration 20260611213725). All access is server-side via
-- getSupabaseAdmin(), gated by the application `weekly_sales` permission.
--
-- Idempotent (IF NOT EXISTS everywhere) and additive, so it is safe to re-run and safe
-- to apply while the current Weekly Sales code is still live.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Product alias crosswalk ─────────────────────────────────────────────────
-- Maps a distributor's own item code OR item name to a Source-of-Sales master
-- product_code. Distributor-tagged so the same numeric alias can mean different
-- products across distributors (e.g. EG "3114" vs PS "42698"). alias_kind is part
-- of the unique key so a code-alias and a name-alias that normalize to the same
-- string live in separate namespaces and never block each other.
create table if not exists public.weekly_sales_product_aliases (
  id               uuid primary key default gen_random_uuid(),
  distributor_code text not null,                              -- 'IS' | 'IS-S' | 'PS' | 'EG' | 'RM'
  alias            text not null,                              -- verbatim distributor code OR name
  alias_kind       text not null check (alias_kind in ('code', 'name')),
  normalized_alias text not null,                              -- case/space/Arabic-normalized join key
  product_code     text not null,                              -- Source-of-Sales master code (validated in-app)
  created_by       text,
  updated_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists weekly_sales_product_aliases_uq
  on public.weekly_sales_product_aliases (distributor_code, alias_kind, normalized_alias);
create index if not exists weekly_sales_product_aliases_product_idx
  on public.weekly_sales_product_aliases (product_code);

alter table public.weekly_sales_product_aliases enable row level security;

-- 2. Per-distributor branch -> master region map ─────────────────────────────
-- region_code/region_name come from the Source-of-Sales region master (controlled
-- vocabulary; validated in-app on upsert/import). The parser writes region_code into
-- weekly_sales_rows so the dashboard groups every distributor's "Cairo" into the same
-- bucket and the territory access tier keeps working unchanged.
--
-- raw_branch is the distributor's own key: EG BRANCH_CODE / RM فرع / IS,IS-S Branch
-- Code / PS outlet header. PS stock additionally pins a branch_column_index (its
-- headers can repeat, e.g. "WS Mansoura" twice) and stores branch_header_raw so the
-- parser can detect column drift. excluded=true drops warehouses/platforms/tenders
-- from the rollup (region columns may then be blank).
create table if not exists public.weekly_sales_branch_region_map (
  id                  uuid primary key default gen_random_uuid(),
  distributor_code    text not null,
  raw_branch          text not null,
  normalized_branch   text not null,                           -- case/space/Arabic-normalized join key
  source_file_type    text not null default 'any' check (source_file_type in ('any', 'sales', 'stock')),
  branch_column_index integer,                                 -- REQUIRED for PS stock (repeated headers)
  branch_header_raw   text,                                    -- PS stock: verbatim header for drift detection
  region_code         text not null default '',                -- Source-of-Sales master region code (rollup + access key)
  region_name         text not null default '',                -- Source-of-Sales master region name (display)
  excluded            boolean not null default false,          -- warehouse/platform/tender opted out of totals
  created_by          text,
  updated_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists weekly_sales_branch_region_map_uq
  on public.weekly_sales_branch_region_map
     (distributor_code, source_file_type, normalized_branch, coalesce(branch_column_index, -1));
create index if not exists weekly_sales_branch_region_map_lookup_idx
  on public.weekly_sales_branch_region_map (distributor_code, normalized_branch);

alter table public.weekly_sales_branch_region_map enable row level security;

-- 3. Net / return columns (additive) ─────────────────────────────────────────
-- sales_qty stays GROSS. net_qty = sales_qty - return_qty; sales_value = net_qty x
-- factory_price (recomputed in the parser). The current parser ignores these (they
-- default to 0); the new parser fills them.
alter table public.weekly_sales_rows
  add column if not exists return_qty numeric(18, 6) not null default 0,
  add column if not exists net_qty    numeric(18, 6) not null default 0;

alter table public.weekly_sales_batches
  add column if not exists total_return_qty numeric(18, 6) not null default 0,
  add column if not exists total_net_qty    numeric(18, 6) not null default 0;

comment on table public.weekly_sales_product_aliases is
  'Weekly Sales rebuild: distributor SKU/name -> Source-of-Sales master product_code crosswalk (distributor + alias_kind tagged). Service-role only.';
comment on table public.weekly_sales_branch_region_map is
  'Weekly Sales rebuild: per-distributor branch/outlet -> master region map (region_code validated in-app against Source-of-Sales regions). Service-role only.';

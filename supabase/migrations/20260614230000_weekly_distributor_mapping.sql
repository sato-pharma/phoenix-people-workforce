-- ─────────────────────────────────────────────────────────────────────────────
-- Weekly Sales — unified per-distributor MAPPING table.
--
-- Purpose: let a RAW distributor weekly file be uploaded with NO manual pre-coding.
-- This table stores, per distributor, how the distributor's own raw labels translate
-- to official Phoenix codes:
--   • dimension = 'product' → raw item code/name  → official source_of_sales product_code
--   • dimension = 'region'  → raw branch column / customer code → official region_code
--
-- The official codes themselves (and product price/xfactor) are NOT stored here — they
-- are referenced from the Source-of-Sales product/region masters by code only, exactly
-- as the weekly parser already does. Only the mapping layer is weekly-owned.
--
-- map_type distinguishes POS's separate Sales and Stock files (whose branch columns
-- differ); every other distributor uses 'combined'.
--
-- This SUPERSEDES the POS-only weekly_sales_pos_region_mappings table: its rows are
-- copied in below as dimension='region'. The old table is left in place (unused) and
-- dropped in a later migration once this is verified in production.
--
-- RLS: enabled, NO public policies. Server-side service-role access only, gated by the
-- application weekly_sales permission — mirroring every other weekly_sales_* table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.weekly_distributor_mapping (
  id uuid primary key default gen_random_uuid(),
  distributor_code text not null,
  dimension text not null check (dimension in ('product', 'region')),
  map_type text not null default 'combined' check (map_type in ('sales', 'stock', 'combined')),
  raw_value text not null,
  normalized_raw_value text not null,
  official_code text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (distributor_code, dimension, map_type, normalized_raw_value)
);

create index if not exists weekly_distributor_mapping_lookup_idx
  on public.weekly_distributor_mapping (distributor_code, dimension, map_type);
create index if not exists weekly_distributor_mapping_official_idx
  on public.weekly_distributor_mapping (dimension, official_code);

alter table public.weekly_distributor_mapping enable row level security;

comment on table public.weekly_distributor_mapping is
  'Weekly Sales per-distributor mapping: distributor raw label -> official product_code/region_code. Official codes referenced from source_of_sales masters by code only.';

-- Carry the existing POS branch->region mappings into the unified table as region rows.
-- Idempotent: re-running skips rows already present (unique key).
insert into public.weekly_distributor_mapping
  (distributor_code, dimension, map_type, raw_value, normalized_raw_value, official_code, updated_by, created_at, updated_at)
select
  m.distributor_code,
  'region',
  coalesce(m.map_type, 'combined'),
  m.raw_column_name,
  m.normalized_column_name,
  m.region_code,
  m.updated_by,
  m.created_at,
  m.updated_at
from public.weekly_sales_pos_region_mappings m
on conflict (distributor_code, dimension, map_type, normalized_raw_value) do nothing;

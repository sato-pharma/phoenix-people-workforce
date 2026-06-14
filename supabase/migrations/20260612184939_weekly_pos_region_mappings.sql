-- Weekly Sales POS region mappings.
--
-- The overseas POS weekly file is a wide matrix and its outlet/territory columns are not stable.
-- Do not infer regions from those column names during import. Admins map each raw POS column to an
-- official Source of Sales region code once; weekly import then uses only that mapping plus the
-- source_of_sales_regions reference table for display names.
--
-- RLS is enabled with no public policies. Access is server-side through the service-role client and
-- gated by the application weekly_sales:import permission, matching the weekly_sales_* tables.

create table if not exists public.weekly_sales_pos_region_mappings (
  id uuid primary key default gen_random_uuid(),
  distributor_code text not null default 'PS',
  raw_column_name text not null,
  normalized_column_name text not null,
  region_code text not null,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (distributor_code, normalized_column_name)
);

create index if not exists weekly_sales_pos_region_mappings_region_idx
  on public.weekly_sales_pos_region_mappings (region_code);

alter table public.weekly_sales_pos_region_mappings enable row level security;

comment on table public.weekly_sales_pos_region_mappings is
  'Admin-maintained mapping from unstable weekly POS matrix outlet columns to official source_of_sales_regions.region_code.';

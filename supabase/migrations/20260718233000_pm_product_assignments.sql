-- Product-Manager product assignments.
--
-- Maps a Product Manager / Group Product Manager (hr_id) to the product codes they
-- own, so Employee 360 attributes their sales by PRODUCT instead of a team roll-up
-- (a PM has no direct reports, so the roll-up path returns nothing). Product codes
-- reference source_of_sales_products.product_code (the SoS product master). Managed
-- from /admin/pm-products (Super Admin edits; CEO / SFE Manager read-only).
--
-- Owner-gated migration: reviewed and applied to staging first, then production,
-- only on explicit owner approval.

create table if not exists public.pm_product_assignments (
  id bigint generated always as identity primary key,
  hr_id text not null,
  product_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  unique (hr_id, product_code)
);

create index if not exists pm_product_assignments_hr_id_idx
  on public.pm_product_assignments (hr_id);
create index if not exists pm_product_assignments_product_code_idx
  on public.pm_product_assignments (product_code);

-- The app reads/writes exclusively through getSupabaseAdmin() AFTER enforcing role
-- in the route (Super Admin to write; CEO / SFE Manager / Super Admin to read).
-- Enable RLS with NO permissive policies so only the service role (which bypasses
-- RLS) can touch it — the anon/authenticated clients get nothing.
alter table public.pm_product_assignments enable row level security;

comment on table public.pm_product_assignments is
  'PM/GPM -> owned product codes (source_of_sales_products.product_code) for Employee 360 product-based sales attribution. Managed via /admin/pm-products (Super Admin edit; CEO/SFE read).';

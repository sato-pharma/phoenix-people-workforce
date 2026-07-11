-- Sales managers — explicit per-person REGION scope (authoritative territory map).
--
-- District Managers and the Regional Manager see ONLY the SoS region codes assigned to them here.
-- This replaces fuzzy region-NAME matching + the hardcoded "Pedia RSM -> AB,D1,D2" special case with
-- an explicit, owner-maintained mapping that drives BOTH weekly and monthly sales scope. A manager
-- with no rows here falls back to auto region-name resolution in application code (graceful, never
-- empty-by-accident). National Sales Managers (whole line) and Product/Group Product Managers
-- (product-scoped) are intentionally NOT represented here.
--
-- Keyed by canonical (lower-cased) HR_ID, like weekly_sales_product_scope. Region codes are the SoS
-- region master codes (AB=Alex-BHR, CA=Cairo, D1=Delta 1, D2=Delta 2, GZ=Giza, UE=Upper Egypt).
--
-- RLS is enabled with NO policies: all access is server-side via the service-role client, gated by
-- the sales permission in the route handlers (same model as weekly_sales_product_scope).

create table if not exists public.sales_manager_region_scope (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  region_code text not null,
  created_by text,
  created_at timestamptz not null default now(),
  unique (hr_id, region_code)
);

create index if not exists sales_manager_region_scope_hr_id_idx
  on public.sales_manager_region_scope (hr_id);

alter table public.sales_manager_region_scope enable row level security;

-- Seed the authoritative territory map (re-runnable). HR_IDs are canonical lower-case; region codes
-- are SoS region master codes. District Managers -> their single region; Regional Manager PD-0001
-- (Alexandria + Delta) -> AB + D1 + D2. Only ACTIVE managers are seeded; a newly hired manager is
-- added here (or auto-resolves from his region name) to gain scope. Cairo currently has 2 active DMs
-- (b-116, ai-0001); the 3rd seat is vacant — the new hire is added when filled. (b-180 resigned and
-- b-101 terminated, so neither is seeded.)
insert into public.sales_manager_region_scope (hr_id, region_code, created_by) values
  -- Alex-BHR (AB)
  ('b-74',  'AB', 'seed:territory_map'),
  ('b-119', 'AB', 'seed:territory_map'),
  ('b-156', 'AB', 'seed:territory_map'),
  -- Cairo (CA) — 2 active DMs (3rd seat vacant)
  ('b-116', 'CA', 'seed:territory_map'),
  ('ai-0001', 'CA', 'seed:territory_map'),
  -- Delta 1 (D1)
  ('b-12',  'D1', 'seed:territory_map'),
  ('b-120', 'D1', 'seed:territory_map'),
  ('b-154', 'D1', 'seed:territory_map'),
  -- Delta 2 (D2)
  ('b-5',   'D2', 'seed:territory_map'),
  ('b-76',  'D2', 'seed:territory_map'),
  ('b-184', 'D2', 'seed:territory_map'),
  -- Giza (GZ)
  ('b-28',  'GZ', 'seed:territory_map'),
  ('b-117', 'GZ', 'seed:territory_map'),
  ('b-94',  'GZ', 'seed:territory_map'),
  -- Upper Egypt (UE)
  ('b-175', 'UE', 'seed:territory_map'),
  ('b-118', 'UE', 'seed:territory_map'),
  ('b-23',  'UE', 'seed:territory_map'),
  -- Regional Manager PD-0001 (Alexandria + Delta) -> AB + D1 + D2
  ('pd-0001', 'AB', 'seed:territory_map'),
  ('pd-0001', 'D1', 'seed:territory_map'),
  ('pd-0001', 'D2', 'seed:territory_map')
on conflict (hr_id, region_code) do nothing;

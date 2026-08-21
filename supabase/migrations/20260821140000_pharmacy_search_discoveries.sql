-- Pharmacy Search — the one table the search engine writes to.
--
-- Pharmacy Search reads the whole customer estate and, when a pharmacy is NOT in it, finds the
-- place on Google and snaps its coordinate to the nearest brick centroid. That answer has to land
-- somewhere when a human presses Save, and it must NOT land in source_of_sales_customer_map:
-- that table drives sales attribution, so a Google-derived brick written into it would silently
-- change which area gets credited for real sales, and there is no distributor customer code to
-- key such a row on anyway.
--
-- So discoveries live here instead — a staging register of "pharmacies we found but do not sell
-- to yet". Nothing downstream reads it for attribution. Promoting a discovery into the real
-- mapping stays a separate, deliberate act.

create table if not exists public.pharmacy_search_discoveries (
  id uuid primary key default gen_random_uuid(),

  -- Google's own id for the place. Unique so pressing Save twice updates rather than duplicates.
  google_place_id text not null unique,
  pharmacy_name text not null,
  google_address text,

  latitude double precision,
  longitude double precision,

  -- The DERIVED territory. brick_id is nearest-centroid, never a confirmed mapping -- hence
  -- snap_distance_km alongside it: without the distance the brick reads as fact.
  brick_id text,
  area_code text,
  region_code text,
  snap_distance_km numeric(6, 2),

  notes text,

  saved_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The board's primary read: newest discoveries first.
create index if not exists pharmacy_search_discoveries_created_idx
  on public.pharmacy_search_discoveries (created_at desc);

-- "What have we found in this brick / area that we do not sell to yet" -- the question this
-- register exists to answer.
create index if not exists pharmacy_search_discoveries_brick_idx
  on public.pharmacy_search_discoveries (brick_id)
  where brick_id is not null;

alter table public.pharmacy_search_discoveries enable row level security;

-- Same posture as every other admin-read table here: service-role only, no anon/authenticated
-- grant. Visibility in this app is application-scoped -- the route asserts the permission before
-- it reads, and this table is reachable only through Pharmacy Search.
revoke all on table public.pharmacy_search_discoveries from anon, authenticated;

grant select, insert, update, delete on table public.pharmacy_search_discoveries to service_role;

drop policy if exists pharmacy_search_discoveries_service_role on public.pharmacy_search_discoveries;
create policy pharmacy_search_discoveries_service_role
  on public.pharmacy_search_discoveries
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.pharmacy_search_discoveries is
  'Pharmacies found via Google through Pharmacy Search that are NOT in source_of_sales_customer_map. Saved only when a human presses Save. brick_id/area_code/region_code are DERIVED by snapping the Google coordinate to the nearest brick centroid -- read snap_distance_km before trusting them, and never treat a row here as a sales mapping.';

comment on column public.pharmacy_search_discoveries.snap_distance_km is
  'Straight-line km from the Google coordinate to the centroid of brick_id. Small (<1km) is as good as a mapping; large (>5km) is a hint only. Null when no brick was within 25km.';

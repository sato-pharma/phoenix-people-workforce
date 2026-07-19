-- Direct Orders — owner refinements (Phase B2):
--   1. Public price on the product master (for discount-mode pricing).
--   2. Mandatory, multi-distributor customer codes per direct-order pharmacy
--      (child table; the "exactly like distributors" attribution anchor).
--   3. Deal type on a request: 'bonus' (qty×factory) or 'discount' (qty×public×(1−disc%)).
--   4. UI-editable bonus & discount caps (config table; seeded 25/25, Ivyronc bonus 30).
--   5. Non-blocking geo-variance state (submitter brick vs customer-map brick) for the
--      admin variance page.

begin;

-- ── 1. Public price on the product master ────────────────────────────────────
alter table public.source_of_sales_products
  add column if not exists public_price numeric(18,6);

-- ── 2. Multi-distributor customer codes per direct-order pharmacy ─────────────
create table if not exists public.direct_order_pharmacy_distributor_codes (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.direct_order_pharmacies (id) on delete cascade,
  distributor_code text not null,
  customer_code text not null,
  -- Resolved from source_of_sales_customer_map at entry (null when the code isn't mapped yet).
  mapped_brick_id text,
  mapped_area_code text,
  mapped_region_code text,
  created_at timestamptz not null default now(),
  unique (pharmacy_id, distributor_code)
);
create index if not exists dop_dist_codes_pharmacy_idx
  on public.direct_order_pharmacy_distributor_codes (pharmacy_id);
alter table public.direct_order_pharmacy_distributor_codes enable row level security;

-- Geo-variance resolution state on the pharmacy (submitter brick vs mapped brick).
alter table public.direct_order_pharmacies
  add column if not exists geo_variance_resolved boolean not null default false;
alter table public.direct_order_pharmacies
  add column if not exists geo_variance_resolution text
    check (geo_variance_resolution in ('kept', 'applied'));
alter table public.direct_order_pharmacies
  add column if not exists geo_variance_resolved_by text;
alter table public.direct_order_pharmacies
  add column if not exists geo_variance_resolved_at timestamptz;

-- ── 3. Deal type on the request ──────────────────────────────────────────────
alter table public.direct_order_requests
  add column if not exists deal_type text not null default 'bonus'
    check (deal_type in ('bonus', 'discount'));
alter table public.direct_order_requests
  add column if not exists discount_pct numeric(6,3) check (discount_pct is null or (discount_pct >= 0 and discount_pct <= 100));
alter table public.direct_order_requests
  add column if not exists public_price_snapshot numeric(18,6);

-- ── 4. UI-editable caps config ───────────────────────────────────────────────
-- product_code '__GLOBAL__' holds the default caps; other rows are per-product overrides.
-- A null bonus/discount cap on a product row means "inherit the global default".
create table if not exists public.direct_order_caps (
  id uuid primary key default gen_random_uuid(),
  product_code text not null unique,
  bonus_cap_pct numeric(6,3) check (bonus_cap_pct is null or (bonus_cap_pct >= 0 and bonus_cap_pct <= 100)),
  discount_cap_pct numeric(6,3) check (discount_cap_pct is null or (discount_cap_pct >= 0 and discount_cap_pct <= 100)),
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.direct_order_caps enable row level security;

insert into public.direct_order_caps (product_code, bonus_cap_pct, discount_cap_pct, updated_by)
values
  ('__GLOBAL__', 25, 25, 'system'),
  ('IV001', 30, null, 'system')
on conflict (product_code) do nothing;

notify pgrst, 'reload schema';

commit;

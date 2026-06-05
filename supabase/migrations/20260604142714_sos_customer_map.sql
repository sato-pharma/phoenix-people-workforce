create table if not exists public.source_of_sales_customer_map (
  id bigint generated always as identity primary key,
  distributor_code text not null,
  customer_code text not null,
  customer_name text,
  address text,
  brick_id text,
  area_code text,
  region_code text,
  source text not null default 'manual',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (distributor_code, customer_code)
);

create index if not exists source_of_sales_customer_map_lookup_idx
  on public.source_of_sales_customer_map (distributor_code, customer_code) where active;

alter table public.source_of_sales_customer_map enable row level security;;

-- Weekly Sales — per-person product scope.
--
-- Product / Group Product / Marketing Managers see ONLY the product codes assigned to them here
-- (line is ignored for those roles). Keyed by canonical (lower-cased) HR_ID so one person can own
-- an arbitrary subset of products. Full-access exception accounts (admin-hr, b-10, aa) and the
-- sales-field roles are NOT represented here — they are scoped in application code.
--
-- RLS is enabled with NO policies: like every weekly_sales table, all access is server-side via the
-- service-role client and gated by the weekly_sales permission in the route handlers.

create table if not exists public.weekly_sales_product_scope (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  product_code text not null,
  created_by text,
  created_at timestamptz not null default now(),
  unique (hr_id, product_code)
);

create index if not exists weekly_sales_product_scope_hr_id_idx
  on public.weekly_sales_product_scope (hr_id);

alter table public.weekly_sales_product_scope enable row level security;

-- Seed the initial assignments from the products_per_position sheet. Osteosat (uncoded) and the
-- Lacto Basic products (exception-only) are intentionally omitted. Re-runnable.
insert into public.weekly_sales_product_scope (hr_id, product_code, created_by) values
  ('a-2', 'CO001', 'seed:products_per_position'),
  ('a-2', 'CO002', 'seed:products_per_position'),
  ('a-2', 'CO003', 'seed:products_per_position'),
  ('a-2', 'CO004', 'seed:products_per_position'),
  ('a-2', 'DO001', 'seed:products_per_position'),
  ('a-2', 'DO002', 'seed:products_per_position'),
  ('a-2', 'DO003', 'seed:products_per_position'),
  ('a-2', 'GU001', 'seed:products_per_position'),
  ('a-2', 'IV001', 'seed:products_per_position'),
  ('a-2', 'LA001', 'seed:products_per_position'),
  ('a-2', 'LA002', 'seed:products_per_position'),
  ('a-2', 'RI001', 'seed:products_per_position'),
  ('a-2', 'RI002', 'seed:products_per_position'),
  ('a-2', 'RI003', 'seed:products_per_position'),
  ('a-2', 'RO001', 'seed:products_per_position'),
  ('a-2', 'SA001', 'seed:products_per_position'),
  ('a-2', 'TE001', 'seed:products_per_position'),
  ('a-2', 'TE002', 'seed:products_per_position'),
  ('a-2', 'TE003', 'seed:products_per_position'),
  ('a-2', 'TE004', 'seed:products_per_position'),
  ('a-2', 'TE005', 'seed:products_per_position'),
  ('a-9', 'CO001', 'seed:products_per_position'),
  ('a-9', 'CO002', 'seed:products_per_position'),
  ('a-9', 'CO003', 'seed:products_per_position'),
  ('a-9', 'CO004', 'seed:products_per_position'),
  ('a-9', 'DO001', 'seed:products_per_position'),
  ('a-9', 'DO002', 'seed:products_per_position'),
  ('a-9', 'DO003', 'seed:products_per_position'),
  ('a-9', 'GU001', 'seed:products_per_position'),
  ('a-9', 'IV001', 'seed:products_per_position'),
  ('a-9', 'LA001', 'seed:products_per_position'),
  ('a-9', 'LA002', 'seed:products_per_position'),
  ('a-9', 'RI001', 'seed:products_per_position'),
  ('a-9', 'RI002', 'seed:products_per_position'),
  ('a-9', 'RI003', 'seed:products_per_position'),
  ('a-9', 'RO001', 'seed:products_per_position'),
  ('a-9', 'SA001', 'seed:products_per_position'),
  ('a-9', 'TE001', 'seed:products_per_position'),
  ('a-9', 'TE002', 'seed:products_per_position'),
  ('a-9', 'TE003', 'seed:products_per_position'),
  ('a-9', 'TE004', 'seed:products_per_position'),
  ('a-9', 'TE005', 'seed:products_per_position'),
  ('a-9', 'SS001', 'seed:products_per_position'),
  ('a-8', 'GU001', 'seed:products_per_position'),
  ('a-8', 'IV001', 'seed:products_per_position'),
  ('a-8', 'LA001', 'seed:products_per_position'),
  ('a-8', 'LA002', 'seed:products_per_position'),
  ('a-10', 'RO001', 'seed:products_per_position'),
  ('a-10', 'SA001', 'seed:products_per_position')
on conflict (hr_id, product_code) do nothing;

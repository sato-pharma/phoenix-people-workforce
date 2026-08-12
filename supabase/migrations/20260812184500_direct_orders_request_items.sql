-- Direct Orders — one request may carry several products from ONE family (owner, 2026-08-12)
--
-- THE ASK: "in the same request make him able to choose lacto adv 1 and lacto adv 2 but this only
-- with lacto". So a request stops being one product and becomes a basket — but only Lacto may hold
-- more than one line today. Tebofortin's seven concentrations and Conviban's four stay
-- one-per-request until somebody deliberately allows them.
--
-- THE SCHEMA IS GENERAL, THE POLICY IS NARROW. This table can hold any number of lines; which
-- families may USE more than one lives in src/lib/direct-orders/product-family.ts
-- (MULTI_ITEM_FAMILY_CODES = ['LA']). The database enforces the invariant that actually protects
-- the money — every line in a request belongs to the SAME family — and leaves the narrower
-- allow-list to the service, because that one is a business preference that will change.
--
-- NOTHING CHANGES FOR EXISTING DATA. Every request alive today becomes a one-item request whose
-- single line is backfilled from its own columns, so `select * from items where request_id = x`
-- returns exactly what the request already said. The singular columns on the request are KEPT and
-- keep their meaning for a one-item order; see the note on them below.

--
-- RENAMED TWICE ON 2026-08-12, WHICH IS THE POINT. Written as 20260812160000_direct_orders_request_items.sql and
-- applied to STAGING under that name. The outstation expense_claims phases were landing on main
-- in parallel and took that timestamp, so check:migrations refused the push; moved to 20260812170000
-- and applied to PRODUCTION under THAT name; expense_claims then took that slot too. Hence the
-- minute-precise timestamp here, deliberately off the round-hour cadence that sequence walks.
-- The CONTENT never changed through any of it — verified 2026-08-12 by fingerprinting the live
-- objects on both projects: the rebuild RPC, the family guard and the items table's column shape
-- all md5-match between staging and production.
--
-- APPLIED TO BOTH PROJECTS via scripts/apply-sql-file.mjs, which does not write to
-- schema_migrations at all. So NEITHER ledger has a row for this file under ANY name — not the old
-- timestamps, not the new one. (An earlier version of this note claimed staging recorded the old
-- timestamp. It does not; staging's ledger has no row for it whatsoever. Checked, not assumed.)
--
-- That is why the file is listed in scripts/check-migrations-applied.ts, whose exceptions set is
-- global and therefore covers both legs of the daily drift check. The evidence there — direct
-- schema inspection, never schema_migrations — is what records the apply in this repo.

begin;

-- 1) The family a request belongs to. Nullable for now: the backfill fills it from the catalogue,
--    and a request whose product is missing from the catalogue (historic data) must not block this
--    migration. The service always sets it on new requests.
alter table public.direct_order_requests
  add column if not exists family_code text;

-- 2) The lines.
create table if not exists public.direct_order_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_order_requests (id) on delete cascade,
  -- 1-based, stable, and unique per request: the order the requester entered them, which is the
  -- order the approval email and the order page list them in.
  line_no integer not null check (line_no >= 1),

  product_code text not null,
  product_name text not null,
  -- Denormalised so a line can be read without joining the catalogue, and so a later rename of a
  -- product cannot silently rewrite history. Same reasoning as product_name on the request.
  family_code text not null,

  -- The price snapshots a line's deal is computed from. A basket can mix a bonus line and a
  -- discount line, and each needs its own basis.
  --
  -- NO factory_price_snapshot, deliberately. The requests table declares one in the foundation
  -- migration, but PRODUCTION DOES NOT HAVE IT — checked on 2026-08-12, and staging does, so the two
  -- have drifted. Nothing writes it either: the service never sets it and mapRequestRow never reads
  -- it. Carrying it here would add a NOT NULL that no code populates, and a backfill referencing the
  -- request's copy would fail outright on production. A direct order is priced from the public or
  -- pharmacy price; the factory price is explicitly never used (see resolveDirectOrderPricing).
  public_price_snapshot numeric(18,6),
  pharmacy_price_snapshot numeric(18,6),

  deal_type text not null default 'bonus' check (deal_type in ('bonus', 'discount')),
  qty numeric(18,3) not null check (qty > 0),
  bonus numeric(18,3) not null default 0 check (bonus >= 0),
  discount_pct numeric(9,4),

  -- This line's money. The request's sales_value is the SUM of these — see the note in step 4.
  sales_value numeric(18,2) not null check (sales_value >= 0),

  -- Over the product's bonus/discount cap. FLAGGED, NEVER BLOCKING (owner, 2026-08-12: "bonus never
  -- override never block a request but flag") — which is what the module already did; this records
  -- it per line so an approver can see WHICH concentration is over, not just that one of them is.
  over_cap boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint direct_order_request_items_line_unique unique (request_id, line_no),
  -- One line per product. Two lines for Lacto Advanced 1 is one line entered badly, and summing
  -- them silently would hide a mistake in the money.
  constraint direct_order_request_items_product_unique unique (request_id, product_code)
);

create index if not exists direct_order_request_items_request_idx
  on public.direct_order_request_items (request_id);
create index if not exists direct_order_request_items_product_idx
  on public.direct_order_request_items (product_code);

-- 3) Backfill: every existing request becomes a one-item request, byte-identical in meaning.
--
--    family_code comes from the catalogue where the product is known, and falls back to the product
--    code's own leading letters ONLY as a last resort for a product the catalogue has since dropped
--    — a historic row must not be given a family it might share with something unrelated, so the
--    fallback is the code itself, which can only ever match that same product.
insert into public.direct_order_request_items (
  request_id, line_no, product_code, product_name, family_code,
  public_price_snapshot, pharmacy_price_snapshot,
  deal_type, qty, bonus, discount_pct, sales_value, created_at, updated_at
)
select
  r.id, 1, r.product_code, r.product_name,
  coalesce(nullif(btrim(p.family_code), ''), 'UNKNOWN:' || r.product_code),
  r.public_price_snapshot, r.pharmacy_price_snapshot,
  r.deal_type, r.qty, r.bonus, r.discount_pct, r.sales_value, r.created_at, r.updated_at
from public.direct_order_requests r
left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
where not exists (
  select 1 from public.direct_order_request_items i where i.request_id = r.id
);

update public.direct_order_requests r
set family_code = i.family_code
from public.direct_order_request_items i
where i.request_id = r.id and i.line_no = 1 and r.family_code is null;

-- 4) THE INVARIANT THE DATABASE OWNS: every line of a request shares the request's family.
--
--    A trigger rather than a CHECK, because the rule spans two tables. Deliberately NOT enforcing
--    the multi-item allow-list here: which families may exceed one line is a business preference
--    (today Lacto only) that will change, and baking it into a constraint would mean a migration
--    every time it does. Mixing families is different — that one is never correct, so it is refused
--    at the lowest level where a future writer cannot forget it.
create or replace function public.phx_direct_order_item_family_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_family text;
begin
  select family_code into v_request_family
  from public.direct_order_requests
  where id = new.request_id;

  -- A request whose family was never resolved (historic data) adopts its first line's family rather
  -- than refusing it. Refusing would make old requests uneditable for a reason their author could
  -- do nothing about.
  if v_request_family is null then
    update public.direct_order_requests set family_code = new.family_code where id = new.request_id;
    return new;
  end if;

  if upper(btrim(v_request_family)) <> upper(btrim(new.family_code)) then
    raise exception
      'direct order % is a % basket; % belongs to family % and cannot be added to it',
      new.request_id, v_request_family, new.product_code, new.family_code
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- A new function in `public` inherits PostgreSQL's built-in EXECUTE grant to PUBLIC, and every
-- login role including anon is a member of PUBLIC. Revoking from anon/authenticated alone is a
-- no-op against that. This one is a trigger function and so cannot be called directly at all, but
-- the rule is uniform on purpose: an exception argued for one function is the precedent for the
-- next. See 20260719170000_phx_harden_public_function_default_execute.sql.
revoke execute on function public.phx_direct_order_item_family_guard() from public, anon, authenticated;

drop trigger if exists direct_order_request_items_family_guard on public.direct_order_request_items;
create trigger direct_order_request_items_family_guard
  before insert or update of family_code, request_id, product_code
  on public.direct_order_request_items
  for each row execute function public.phx_direct_order_item_family_guard();

-- 5) The singular columns on direct_order_requests are KEPT, and keep meaning what they meant.
--
--    They are read by roughly thirty files. For the one-item requests that are every order raised
--    before today — and every order that is not Lacto after it — they are still the whole truth.
--    For a multi-item basket they describe LINE 1, and `sales_value` is the BASKET TOTAL.
--
--    That last part is the deliberate asymmetry, and it is the safe one: `remaining_amount` in the
--    collection model derives from `sales_value`, the report sorts on it, and the Source-of-Sales
--    batch header totals it. Keeping it the sum means Finance and collection need no change at all
--    and cannot under-count a basket. Anything wanting per-line detail reads the items.
comment on column public.direct_order_requests.sales_value is
  'Basket TOTAL: the sum of direct_order_request_items.sales_value. Equal to line 1 for a one-item request.';
comment on column public.direct_order_requests.product_code is
  'Line 1''s product. For a multi-item basket, read direct_order_request_items for the full set.';
comment on column public.direct_order_requests.family_code is
  'The one family every line of this request belongs to. Enforced by phx_direct_order_item_family_guard.';

-- 6) RLS parity with the rest of the module: enabled, service-role only. Every other
--    direct_order_* table is in exactly this state, and a new table that quietly is not would be
--    reachable with the anon key.
alter table public.direct_order_request_items enable row level security;

drop policy if exists direct_order_request_items_service_role on public.direct_order_request_items;
create policy direct_order_request_items_service_role
  on public.direct_order_request_items
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.direct_order_request_items from anon, authenticated;
grant all on public.direct_order_request_items to service_role;

-- 7) Prove the backfill actually landed. An INSERT ... WHERE NOT EXISTS that matched nothing is
--    silent, and a silently-empty items table would make every request look like it has no
--    products the moment a reader switches to items.
do $$
declare
  v_requests bigint;
  v_without_items bigint;
  v_mismatched bigint;
begin
  select count(*) into v_requests from public.direct_order_requests;

  select count(*) into v_without_items
  from public.direct_order_requests r
  where not exists (select 1 from public.direct_order_request_items i where i.request_id = r.id);

  if v_without_items > 0 then
    raise exception 'backfill incomplete: % of % requests have no items', v_without_items, v_requests;
  end if;

  -- For every one-item request the line's value must equal the request's, or the sum-semantics in
  -- step 5 are already wrong on day one.
  select count(*) into v_mismatched
  from public.direct_order_requests r
  join public.direct_order_request_items i on i.request_id = r.id
  where i.line_no = 1
    and (select count(*) from public.direct_order_request_items x where x.request_id = r.id) = 1
    and i.sales_value <> r.sales_value;

  if v_mismatched > 0 then
    raise exception 'backfill mismatch: % single-item requests whose line value <> request value', v_mismatched;
  end if;

  raise notice 'direct_order_request_items: % requests backfilled, all values agree', v_requests;
end $$;

commit;

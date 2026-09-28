-- period_scoped_factory_prices
--
-- WHAT THIS CHANGES:
--   Adds `public.source_of_sales_product_price_history` — a sparse override table saying "from
--   period P onward, this product's factory price is X" — and the resolver
--   `public.phx_factory_price(product_code, period)`, which reads it and falls back to today's
--   `source_of_sales_products.factory_price` when no override covers that period. Seeds one row:
--   Saginko SA001 at 170.52 from 2026-10.
--
--   Nothing reads the resolver yet. The companion migration repoints the sales-value functions at
--   it; this file is inert on its own, which is deliberate — it can be applied and inspected
--   before a single number moves.
--
-- WHY:
--   Owner instruction, 2026-09-28: Saginko is repriced to xfactory 170.52 / public 270 / pharmacy
--   209.52. The two direct-order prices went live on the product master the same day, and direct
--   orders snapshot their price at submit, so that half is forward-only by construction. The
--   xfactory price is not: the closing engine values EVERY month as `units × the CURRENT factory
--   price`, so a flat edit would have restated Jan–Aug by +1,814,407 EGP, including +194,852 on
--   July and +177,101 on August — both published and locked. The owner's instruction was
--   explicit: "the sales and target of the retail to be adjusted from 1 October".
--
--   This is the first period-scoped price in the system. A 2026-08-14 ruling rejected period
--   scoping when the question was how to value pre-July manual closings, and that ruling still
--   governs everything with no override row: absent an override, the current price values every
--   month, exactly as before. The override is the narrow exception the owner asked for, not a new
--   default.
--
-- ROLLBACK:
--   delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   drop function if exists public.phx_factory_price(text, text);
--   drop table if exists public.source_of_sales_product_price_history;
--   Deleting the seed row alone is enough to restore the pre-change valuation everywhere, because
--   the resolver then falls back to `source_of_sales_products.factory_price` for every period.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive: one new table, one new function, one inserted row.

begin;

create table if not exists public.source_of_sales_product_price_history (
  product_code      text        not null references public.source_of_sales_products (product_code) on update cascade,
  -- The FIRST period this price governs, 'YYYY-MM'. Periods before it keep whatever the previous
  -- override — or, with none, `source_of_sales_products.factory_price` — says.
  effective_period  text        not null,
  factory_price     numeric     not null,
  -- Recorded for the audit trail only. Direct orders read the product master and snapshot the
  -- price onto the request at submit, so these two columns are NOT a pricing source for anything.
  public_price      numeric,
  pharmacy_price    numeric,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        text,
  primary key (product_code, effective_period),
  constraint source_of_sales_product_price_history_period_shape
    check (effective_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Short by design: the obvious name is 64+ characters and Postgres truncates it silently, which
  -- would leave the file and the catalog disagreeing about what the constraint is called.
  constraint sos_product_price_history_factory_price_non_negative
    check (factory_price >= 0)
);

comment on table public.source_of_sales_product_price_history is
  'Sparse period-scoped factory-price overrides. A row means "from effective_period onward this '
  'product is valued at factory_price". A product with no row here is valued at '
  'source_of_sales_products.factory_price for every period, which is the owner''s 2026-08-14 '
  'policy and remains the default. Read only through public.phx_factory_price().';

-- A product with no override is the overwhelming majority, so the resolver's index-only path on
-- (product_code, effective_period desc) is what keeps a per-row call cheap.
create index if not exists source_of_sales_product_price_history_lookup_idx
  on public.source_of_sales_product_price_history (product_code, effective_period desc);

-- Visibility in this app is application-scoped, not RLS-scoped, and every reader of this table is
-- a SECURITY DEFINER function or the service-role client. RLS on with no policy plus no browser
-- grant is the house shape for that (~4 in 5 public tables here).
alter table public.source_of_sales_product_price_history enable row level security;
revoke all on table public.source_of_sales_product_price_history from anon, authenticated;
grant select, insert, update, delete on table public.source_of_sales_product_price_history to service_role;

-- ── The resolver ────────────────────────────────────────────────────────────────────────────
-- Always answers: an override if one covers the period, otherwise the product master's current
-- price. It can return NULL only for a product code that exists in neither table, which is the
-- same answer the LEFT JOIN it replaces gave, so every caller's existing coalesce(..., 0) keeps
-- its meaning.
--
-- A NULL period falls through to the master price rather than erroring — `h.effective_period <=
-- null` matches no rows — which is the right answer for the handful of callers that value a row
-- with no period in scope.
create or replace function public.phx_factory_price(p_product_code text, p_period text)
 returns numeric
 language sql
 stable
 parallel safe
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (select h.factory_price
       from public.source_of_sales_product_price_history h
      where upper(btrim(h.product_code)) = upper(btrim(p_product_code))
        and h.effective_period <= p_period
      order by h.effective_period desc
      limit 1),
    (select pr.factory_price
       from public.source_of_sales_products pr
      where upper(btrim(pr.product_code)) = upper(btrim(p_product_code))
      limit 1)
  );
$function$;

comment on function public.phx_factory_price(text, text) is
  'The factory price that values one product in one period ''YYYY-MM''. Reads '
  'source_of_sales_product_price_history, falling back to source_of_sales_products.factory_price '
  'when no override covers that period. Added 2026-09-28 for the Saginko repricing, which the '
  'owner scoped to 1 October onward.';

revoke execute on function public.phx_factory_price(text, text) from public, anon, authenticated;
grant  execute on function public.phx_factory_price(text, text) to service_role;

-- ── The one override this migration exists for ──────────────────────────────────────────────
insert into public.source_of_sales_product_price_history
  (product_code, effective_period, factory_price, public_price, pharmacy_price, note, created_by)
values
  ('SA001', '2026-10', 170.52, 270, 209.52,
   'Owner instruction 2026-09-28: Saginko repriced from 111.15/180/139.68. The public and pharmacy '
   'prices went live on the product master on 2026-09-28 for direct orders submitted from that day; '
   'retail sales and targets move from 1 October 2026. The two prices here are recorded for the '
   'audit trail and are not read by anything.',
   'B-10')
on conflict (product_code, effective_period) do update
  set factory_price  = excluded.factory_price,
      public_price   = excluded.public_price,
      pharmacy_price = excluded.pharmacy_price,
      note           = excluded.note;

commit;

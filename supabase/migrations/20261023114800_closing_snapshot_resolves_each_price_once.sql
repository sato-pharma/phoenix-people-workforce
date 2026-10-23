-- closing_snapshot_resolves_each_price_once
--
-- WHAT THIS CHANGES:
--   phx_closing_publication_snapshot(text, text)  REPLACED — resolves each product's period price
--                                                 ONCE instead of once per rollup row, and drops a
--                                                 join that has been dead since 2026-09-28. Same
--                                                 answer, byte for byte.
--
-- WHY: the Needs You board's "Published closings that have moved" source timed out on 12 of the 15
-- mornings 9-23 Oct 2026 — the second worst of eleven sources, read from the delivered digests in
-- `notification_events.metadata`. The 2026-10-23 one-compute migration
-- (20261023084810) had already cut three snapshot recomputes per line to one, and the source had
-- already been narrowed to the LATEST published period only. One recompute was still 1.6 s, and
-- three published lines therefore spent most of an 8-second budget before anything else ran.
--
-- 🔴 WHERE THE 1.6 SECONDS ACTUALLY WENT, MEASURED ON PRODUCTION 2026-10-23 (CNS 2026-09):
--
--     phx_closing_publication_snapshot('CNS','2026-09')   1,645 ms   38,963 shared buffers
--     the same query without the `value` aggregate            177 ms        702 shared buffers
--
-- The whole cost is one expression: `public.phx_factory_price(f.product_code, f.period)`, evaluated
-- once per rollup row — 18,558 times for CNS 2026-09, to resolve 15 distinct products. It is a SQL
-- function, so the planner would normally inline it into a join; it cannot, because the function is
-- SECURITY DEFINER, and Postgres never inlines those. So each row paid a full function invocation
-- with its own two subqueries, one page each, which is exactly the 38,963 buffers.
--
-- 🔴 THE FIX IS NOT A WIDER LANE OR A RAISED BUDGET. Those are forbidden (module memory,
-- `sales-closing-screens`: "never answer an amber drift row by widening a lane or raising the
-- board's budget — make the source cheaper"). The price is resolved once per DISTINCT product code
-- in a CTE and joined, which is what the planner would have done by itself had it been allowed to.
--
--     after, same call, same production   241 ms   969 shared buffers    (6.8x faster, 40x fewer pages)
--
-- 🔴 THE ANSWER IS UNCHANGED, AND THAT WAS PROVEN BEFORE THIS WAS WRITTEN, NOT ASSERTED AFTER. The
-- old function and this body were run side by side on production 2026-10-23 over 14 line × period
-- pairs — all nine live publications (2026-07, 2026-08, 2026-09 × Anti Infective, CNS, Pedia), the
-- two price-override months 2026-10 and 2026-11, and Head Office 2026-08 and 2026-09 at 57,070,544.70
-- and 36,770,200.77 EGP. All 14 were identical as text, not merely equal as numbers: `old::text =
-- new::text`, which also pins jsonb key order and every numeric's scale.
--
-- This matters more than usual because this function IS the published baseline: the
-- `trg_publication_take_snapshot` trigger stores its output on the publication row, and
-- phx_closing_publication_drift compares today's output against that stored copy. A body that
-- rounded differently would report drift on every published month at once.
--
-- WHY THE TWO REWRITES ARE EQUIVALENT, not just measured to be:
--
--   1. PRICE PER PRODUCT, NOT PER ROW. The old call was `phx_factory_price(f.product_code, f.period)`,
--      but every row the scan returns has `f.period = p_period` by its own WHERE clause, so the
--      second argument was a constant. `phx_factory_price` is STABLE and depends on nothing else, so
--      its value is a pure function of the product code within one call — and resolving it once per
--      distinct code is the same number for every row carrying that code. The join is a plain `=`:
--      a row whose product_code matched nothing and a row whose resolved price was NULL both fall to
--      `coalesce(..., 0)`, which is what the function itself returned for an unknown product, so the
--      NULL branch is identical too. Production carries 0 rollup rows with a null product_code.
--   2. THE DEAD JOIN GOES. `left join source_of_sales_products p on upper(btrim(p.product_code)) =
--      upper(btrim(f.product_code))` lost its only consumer on 2026-09-28, when `p.factory_price` was
--      replaced by the resolver; it has been pure cost since. It could also have DOUBLED a cell: a
--      left join fans out on duplicates, so two master rows differing only in case or padding would
--      have multiplied that product's units. Production holds 0 such duplicates
--      (`group by upper(btrim(product_code)) having count(*) > 1`), which is why removing it moves
--      nothing today and why it was a latent unit-doubling bug rather than a tidy-up.
--
-- The CTE column is called `period_price`, deliberately not `factory_price`: `source_of_sales_products`
-- has a column by that name holding the FLAT master price, and `tests/product-period-price.test.ts`
-- rejects any value expression of the form `* coalesce(<alias>.factory_price` precisely because that
-- shape is the bug it was written to catch. The name keeps the two unmistakable.
--
-- 🔴 THE 21 OTHER CALLERS ARE NOT TOUCHED HERE. 22 functions call `phx_factory_price` per row the
-- same way — `phx_monthly_closing_matrix`, `phx_closing_distributor_product`,
-- `phx_closing_channel_breakdown`, the four `phx_exec_*` and the five marketing ROI ones among them —
-- so each of them pays the same per-row price. The one change that would fix all of them at once is
-- dropping SECURITY DEFINER from `phx_factory_price` so the planner can inline it, and that is a
-- change to a security property of a function deliberately revoked from `anon` and `authenticated`
-- (20260928184100). It needs its own measured change and its own review, and it is not bundled into
-- a timeout fix.
--
-- ROLLBACK: re-apply supabase/migrations/20260928190014_phx_closing_publication_snapshot_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched, and
-- no stored snapshot is re-taken.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing
-- here is destructive or bulk: it replaces one read-only function body.

begin;

create or replace function public.phx_closing_publication_snapshot(p_line text, p_period text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with src as (
    select f.area_code, f.product_code, coalesce(f.is_direct, false) as is_direct,
           f.total_qty, f.effective_units, f.direct_value
    from source_of_sales_fact_rollup f
    where f.period = p_period
      and lower(btrim(regexp_replace(f.official_line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
  ),
  -- ONE resolver call per distinct product code, not one per row. Every row in `src` carries
  -- `period = p_period`, so the period argument was already constant across the whole scan.
  prices as (
    select d.product_code, public.phx_factory_price(d.product_code, p_period) as period_price
    from (select distinct s.product_code from src s) d
  ),
  cells as (
    select s.area_code, s.product_code, s.is_direct,
           sum(s.total_qty) as units,
           sum(case when s.is_direct
                    then coalesce(s.direct_value, 0)
                    else s.effective_units * coalesce(pc.period_price, 0)
               end) as value
    from src s
    left join prices pc on pc.product_code = s.product_code
    group by 1, 2, 3
    having sum(s.total_qty) <> 0
  )
  select jsonb_build_object(
    'units', coalesce((select sum(units) from cells), 0),
    'value', coalesce((select sum(value) from cells), 0),
    'cells', (select count(*) from cells),
    'breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('a', area_code, 'p', product_code, 'd', is_direct,
                                          'u', units, 'v', value)
                       order by area_code, product_code, is_direct)
      from cells
    ), '[]'::jsonb)
  );
$function$;

-- `create or replace` keeps the existing ACL; these are restated so the file says out loud that this
-- is a SECURITY DEFINER function over the whole fact rollup and is not reachable with the anon key.
revoke execute on function public.phx_closing_publication_snapshot(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_publication_snapshot(text, text) to service_role;

commit;

-- Market Awareness tracking — the reconciled brick figure, computed beside the closing's own
-- functions rather than in application code.
--
-- WHY A FUNCTION AND NOT A POSTGREST SELECT. An unbounded `.select()` stops at 1000 rows here with
-- no marker, and a `.in()` carrying several hundred ids returns ZERO rows and no error. A tracking
-- window is up to 15 months across several products and bricks, so both traps are live. One RPC
-- returns one aggregated answer.
--
-- WHY THIS RECONCILES. Measured on production (ozucdzovmcqvepbozvqf) for 2026-08:
--
--   line            phx_closing_distributor_product   fact_rollup where not is_direct   diff
--   Anti Infective                            4,811                             4,811      0
--   CNS                                      21,891                            21,891      0
--   Pedia                                    10,290                            10,290      0
--
-- `eff_units` agreed to zero on the same three lines. Head Office diverges (5 vs 272,776) and is the
-- only one that does — it is excluded from this module at the product picker, so it cannot arrive
-- here. So `source_of_sales_fact_rollup` filtered to validated batches and `not is_direct` IS what
-- the closing publishes, and adding `brick_id` to the GROUP BY reconciles BY CONSTRUCTION: the same
-- rows, grouped one level finer.
--
-- BOTH HALVES, ALWAYS. A closing is distributor invoices PLUS direct orders folded onto the row's
-- own area. Quoting the distributor half alone understates the month — that mistake has been made
-- and delivered here before — and flipping `not is_direct` double-counts. They are added.
--
-- The direct half reproduces `phx_monthly_closing_direct` exactly, including its three excluded
-- product codes, and NOT its 2026-07 overlay: that month blanks `area_code` and defers placement to
-- the owner's overlay, so a 2026-07 direct row has no area and therefore no brick. Attributing it
-- would invent a placement the closing itself refuses to make, so it is left out of both scopes. The
-- `area` vs `area_bricked` pair is what surfaces value that could not be placed in a brick, and the
-- service turns any gap into a visible note rather than absorbing it.

-- THE LINE IS PASSED AS `line_code`, NEVER AS A DISPLAY SPELLING. `au.sos_official_line_map` holds
-- FOUR official_line spellings for three lines — "Anti Inf" and "Anti Infective" both map to
-- `anti_infective` — so matching on one spelling silently drops every row written with the other.
-- The failure mode is a zero, and a zero here reads as "this area had no sales" rather than as a
-- missed join. The map is the database's own bridge; this function asks it rather than guessing.
create or replace function public.phx_market_awareness_tracking(
  p_line_code text,
  p_from_period text,
  p_to_period text,
  p_area_code text,
  p_brick_ids text[],
  p_product_codes text[]
)
returns table(
  period text,
  scope text,
  indirect_units numeric,
  indirect_value numeric,
  direct_units numeric,
  direct_value numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with rows_in_window as (
    select
      f.period,
      f.area_code,
      f.brick_id,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value,
      f.product_code
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period between p_from_period and p_to_period
      and lower(btrim(f.official_line)) in (
        select lower(btrim(m.official_line))
        from au.sos_official_line_map m
        where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      )
      and upper(btrim(f.product_code)) = any (
        select upper(btrim(code)) from unnest(p_product_codes) as code
      )
      -- The direct half's own exclusions, copied from phx_monthly_closing_direct so the two cannot
      -- drift apart. They are Head Office products; the picker already refuses them, and this is the
      -- backstop.
      and (
        not f.is_direct
        or upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      )
      -- 2026-07 direct rows carry no area in the closing, so they are placed nowhere here either.
      and not (f.is_direct and f.period = '2026-07')
  ),
  priced as (
    select
      r.*,
      -- The closing revalues at FACTORY price and does not use the invoiced value. Matching it is
      -- the whole point; using the invoice value here would produce a number that looks right and
      -- disagrees with every published closing.
      r.effective_units * coalesce(p.factory_price, 0) as indirect_value
    from rows_in_window r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  ),
  scoped as (
    -- The activity's own bricks.
    select 'brick'::text as scope, * from priced
     where brick_id = any (p_brick_ids)
    union all
    -- The whole area, which is what the brick figure is judged against.
    select 'area'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
    union all
    -- The area counting only rows that carry a brick. Compared against `area`, the gap is the value
    -- that could not be placed in any brick. It was 0 for 2026-08 and about 1.8% for 2026-07, so it
    -- is real and must be shown rather than silently absorbed.
    select 'area_bricked'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
       and brick_id is not null
       and btrim(brick_id) <> ''
  )
  select
    s.period,
    s.scope,
    coalesce(sum(s.total_qty)      filter (where not s.is_direct), 0) as indirect_units,
    coalesce(sum(s.indirect_value) filter (where not s.is_direct), 0) as indirect_value,
    coalesce(sum(s.total_qty)      filter (where s.is_direct), 0)     as direct_units,
    coalesce(sum(s.direct_value)   filter (where s.is_direct), 0)     as direct_value
  from scoped s
  group by s.period, s.scope;
$function$;

comment on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) is
  'Market Awareness tracking series: brick, area, and area-counting-only-bricked-rows, per period, '
  'for one line and a product set. Reads source_of_sales_fact_rollup on validated batches, which '
  'reconciles exactly with phx_closing_distributor_product (verified 0 difference on all three '
  'tracked lines for 2026-08). Returns both halves of the closing separately so a caller can never '
  'quote one of them by accident.';

revoke all on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from public;
revoke all on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from anon;
revoke all on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from authenticated;
grant execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) to service_role;

-- The last period any closing has been published for. The Tracking tab can never show the running
-- month — a closing is publishable only on the first day of the following month — and a screen that
-- renders a half-collected month looks like a collapse in sales.
create or replace function public.phx_market_awareness_last_closed_period()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select max(f.period)
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated';
$function$;

revoke all on function public.phx_market_awareness_last_closed_period() from public;
revoke all on function public.phx_market_awareness_last_closed_period() from anon;
revoke all on function public.phx_market_awareness_last_closed_period() from authenticated;
grant execute on function public.phx_market_awareness_last_closed_period() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it against the closing, rather than assert that it reconciles
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A POSITIVE CONTROL is carried deliberately: an empty result and a broken query are
-- indistinguishable without one, so the block fails if the closing itself returned nothing.

do $verify$
declare
  probe_period text;
  probe_line text;
  probe_line_code text;
  product_codes text[];
  sample_area text;
  closing_value numeric;
  tracking_value numeric;
  drift numeric;
begin
  -- The probe period is DISCOVERED, never named. A hardcoded month turns this block into a test of
  -- whether that month happens to be loaded: '2026-08' failed on staging, whose rollup stops at
  -- 2026-07, for a reason that had nothing to do with the function being verified.
  select max(period) into probe_period
    from public.source_of_sales_distributor_product_rollup;

  if probe_period is null then
    raise notice 'market awareness tracking: this database holds no closing rollup — reconciliation '
      'check skipped. It runs wherever the rollup is populated.';
    return;
  end if;

  -- au.lines is the authority on which lines are closing lines; is_closing_line is what excludes
  -- Head Office rather than a name match. line_name doubles as the argument
  -- phx_closing_distributor_product expects (it lower-cases it to reach line_key), while line_code
  -- is what this function's own map lookup takes.
  select l.line_name, l.line_code into probe_line, probe_line_code
    from au.lines l
    join public.source_of_sales_distributor_product_rollup r
      on lower(btrim(r.line_key)) = lower(btrim(l.line_name))
   where r.period = probe_period
     and l.is_closing_line
     and l.is_active
   group by l.line_name, l.line_code
   order by count(*) desc
   limit 1;

  if probe_line is null then
    raise notice 'market awareness tracking: % holds no closing line — check skipped', probe_period;
    return;
  end if;

  select array_agg(distinct product_code) into product_codes
    from public.phx_closing_distributor_product(probe_line, probe_period);

  -- POSITIVE CONTROL. Without it, an empty result and a broken query are indistinguishable, and a
  -- reconciliation that compares 0 with 0 reports success on a database with no data in it.
  if product_codes is null or array_length(product_codes, 1) is null then
    raise exception 'market awareness tracking: positive control failed — the closing returned no '
      'products for % %, so a zero here would prove nothing', probe_line, probe_period;
  end if;

  select area_code into sample_area
    from public.phx_closing_distributor_product(probe_line, probe_period)
   where coalesce(btrim(area_code), '') <> ''
   group by area_code
   order by sum(value) desc
   limit 1;

  if sample_area is null then
    raise notice 'market awareness tracking: % % places nothing in an area — check skipped',
      probe_line, probe_period;
    return;
  end if;

  select coalesce(sum(value), 0) into closing_value
    from public.phx_closing_distributor_product(probe_line, probe_period)
   where btrim(area_code) = btrim(sample_area);

  select coalesce(sum(t.indirect_value), 0) into tracking_value
    from public.phx_market_awareness_tracking(
      probe_line_code, probe_period, probe_period, sample_area, array[]::text[], product_codes
    ) t
   where t.scope = 'area';

  -- The second half of the positive control: zero on both sides is the shape a broken query takes.
  if closing_value = 0 then
    raise exception 'market awareness tracking: positive control failed — the closing values % % '
      'area % at zero, so agreement here would prove nothing', probe_line, probe_period, sample_area;
  end if;

  drift := abs(closing_value - tracking_value);

  -- One EGP of tolerance for numeric rounding across two different aggregation orders. Anything
  -- larger is a real disagreement with the published closing and must stop the migration.
  if drift > 1 then
    raise exception 'market awareness tracking: area % (% %) disagrees with the closing — closing '
      '%, tracking %, drift %', sample_area, probe_line, probe_period,
      closing_value, tracking_value, drift;
  end if;

  raise notice 'market awareness tracking: % % area % reconciles with the closing (% vs %, drift %)',
    probe_line, probe_period, sample_area, closing_value, tracking_value, drift;
end;
$verify$;

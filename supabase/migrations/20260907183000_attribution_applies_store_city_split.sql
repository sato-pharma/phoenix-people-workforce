-- The wholesaler CITY SPLIT now reaches attribution, so Sales vs Target agrees with the Monthly
-- Closing about which area a wholesaler's units belong to.
--
-- THE PROBLEM THIS FIXES. The split lives in TypeScript (src/lib/sales/store-sales-city-split.ts)
-- and is applied when the Closing Matrix renders. au.f_monthly_attribution reads
-- public.source_of_sales_fact_rollup directly and knows nothing about it, so the two disagreed:
-- measured on production 2026-09-07 for August Pedia, El Qema's Qalubeya wholesalers showed 950.86
-- units in D11 on the closing and 6,656 in D11 on Sales vs Target, with the six Cairo areas getting
-- 994.86 each on the closing and nothing at all on achievement. Every wholesaler split since August
-- 2026 has had this gap; El Qema is simply the first one large enough to be impossible to miss.
-- Owner ruled on 2026-09-07: "yes fix the attribution too, same per line gate".
--
-- 🔴 WHY THE RULE IS NOT RE-IMPLEMENTED HERE, AND MUST NEVER BE. Deciding whether a customer is a
-- wholesaler means folding Arabic letter forms, matching six owner keywords, four override lists, a
-- trade phrase, the never-a-store words and the wholesale-only distributor registry — and then the
-- PER-LINE period gate (Pedia from 2026-08, every other line from 2026-09). That rule already exists
-- once, in TypeScript, pinned by tests in the required CI `validate` job. A SQL copy would be a
-- second rule that drifts silently, and the drift would move money between reps with no error
-- anywhere. So SQL never classifies anybody: the application computes the split and materialises its
-- OUTPUT here as a signed net, and this function only adds numbers up.
--
-- WHAT A NET ROW IS. Per (period, line_code, area_code, product_code), the units this split moves
-- INTO that cell minus the units it moves OUT. Summed over the areas of one (period, line, product)
-- it is always ZERO — the split relocates units, it never creates or destroys them. That invariant
-- is enforced by public.phx_write_monthly_store_split_net below, which REFUSES a payload that does
-- not balance, so a bug in the writer cannot silently change a month's totals.
--
-- 🔴 THIS MIGRATION IS A NO-OP UNTIL THE NET TABLE IS POPULATED, deliberately. With
-- au.monthly_store_split_net empty, every `split` CTE below is empty, the full join adds nothing and
-- au.f_monthly_attribution returns exactly what it returns today — provable with an EXCEPT diff in
-- both directions. That is what makes this safe to apply to production ahead of the application code
-- that fills the table, and it is why the two halves ship as separate steps.
--
-- TWO MEASURES, NOT ONE. The rollup carries total_qty (the invoiced units) and effective_units
-- (qty x (1 - discount)), and attribution uses total_qty for sales_units but effective_units for
-- money. They are equal on all 21,066 production rows from 2026-08 today, but that is a fact about
-- the current data and not a definition, so the net carries both and they are applied to their own
-- measure.
--
-- Verified before writing this, on production (ozucdzovmcqvepbozvqf):
--   * au.sos_area_crosswalk is identity on all 50 rows, so the application's area codes need no
--     translation on the way in.
--   * public.source_of_sales_products has no duplicate product_code, so re-joining the factory price
--     after aggregating effective_units is exactly equivalent to pricing per row and then summing
--     (price is a pure function of product_code, and the group is keyed by product_code).
--   * All seven areas the El Qema rule targets (D11 + CA1..CA6) exist in au.f_line_area_map_asof for
--     'pedia' at 2026-08-31, so the join below cannot drop a net cell and lose its money. CA5 has no
--     rep seat, which is correct and expected — the owner's rule divides by AREAS, not by reps, so a
--     vacant seat still holds its share.

-- =====================================================================================================
-- 1. The materialised split, written by the application. One row per (period, line, area, product).
-- =====================================================================================================
create table if not exists au.monthly_store_split_net (
  period              text not null,
  line_code           text not null,
  area_code           text not null,
  product_code        text not null,
  net_qty             numeric not null default 0,
  net_effective_units numeric not null default 0,
  computed_at         timestamptz not null default now(),
  primary key (period, line_code, area_code, product_code)
);

-- The read path filters a single period, exactly like the attribution rollup beside it.
create index if not exists monthly_store_split_net_period_idx
  on au.monthly_store_split_net (period);

-- No RLS and no browser grants, matching au.monthly_attribution_rollup: `au` is not a
-- PostgREST-exposed schema and every read goes through a SECURITY DEFINER function.

-- =====================================================================================================
-- 2. The writer. The ONLY way this table is filled, so the zero-sum invariant has exactly one gate.
--
--    Takes the whole period at once and replaces it, inside one statement-level transaction: a
--    Supabase client request that times out at 15s still COMMITS, so a delete-then-insert split
--    across two round trips could leave a period half-written with no audit row. One function call
--    cannot.
-- =====================================================================================================
create or replace function public.phx_write_monthly_store_split_net(
  p_period text,
  p_rows   jsonb
)
  returns integer
  language plpgsql
  security definer
  set search_path to 'au', 'public'
as $function$
declare
  v_written  integer := 0;
  v_bad      text;
  v_unmapped text;
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_write_monthly_store_split_net: period must be YYYY-MM, got %', p_period;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'phx_write_monthly_store_split_net: p_rows must be a jsonb array';
  end if;

  -- Read straight from the jsonb rather than staging it in a temp table: a temp table with
  -- `on commit drop` would fail the SECOND call inside one transaction, which is exactly what a
  -- backfill looping over periods does.

  -- 🔴 THE LINE CODE IS RESOLVED HERE, through au.sos_official_line_map — never by string munging in
  -- the caller. THE MAP IS NOT THE IDENTITY: "Anti Infective" resolves to `anti_infective`, so a
  -- caller that merely lower-cased the line name would produce `anti infective`, which joins to
  -- NOTHING in au.f_monthly_attribution. The split would then silently not apply to that line — no
  -- error, no missing row, just a month where one line's wholesalers never moved. Resolving through
  -- the same map attribution groups by is the only way the two cannot drift.
  select string_agg(distinct r->>'official_line', ', ')
    into v_unmapped
  from jsonb_array_elements(p_rows) r
  left join au.sos_official_line_map lm
    on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
  where lm.line_code is null;

  if v_unmapped is not null then
    raise exception
      'phx_write_monthly_store_split_net: no line_code for % - refusing to write a net that would join to nothing',
      v_unmapped;
  end if;

  -- 🔴 THE INVARIANT. A split moves units between the areas of one (line, product); it never changes
  -- how many there are. Refusing here rather than in the application means no future caller — a
  -- script, a backfill, a hand-run repair — can bypass it. Rounding: the shares are exact decimals
  -- and the last share absorbs the remainder, so the sum is exact, but a 1e-9 tolerance is allowed
  -- for float round-tripping through JSON.
  --
  -- Grouped by the RESOLVED line_code, not the incoming name: "Anti Inf" and "Anti Infective" are one
  -- line, and a net that balances only when they are counted separately does not balance at all.
  select string_agg(format('%s/%s: qty %s, units %s', line_code, product_code, sq, se), '; ')
    into v_bad
  from (
    select lm.line_code,
           upper(btrim(r->>'product_code')) as product_code,
           sum((r->>'net_qty')::numeric)             as sq,
           sum((r->>'net_effective_units')::numeric) as se
    from jsonb_array_elements(p_rows) r
    join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
    group by 1, 2
    having abs(sum((r->>'net_qty')::numeric)) > 1e-9
        or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9
  ) unbalanced;

  if v_bad is not null then
    raise exception
      'phx_write_monthly_store_split_net: net does not balance to zero for % - refusing to write (%)',
      p_period, v_bad;
  end if;

  delete from au.monthly_store_split_net where period = p_period;

  insert into au.monthly_store_split_net
    (period, line_code, area_code, product_code, net_qty, net_effective_units, computed_at)
  select p_period,
         lm.line_code,
         upper(btrim(r->>'area_code')),
         upper(btrim(r->>'product_code')),
         sum((r->>'net_qty')::numeric),
         sum((r->>'net_effective_units')::numeric),
         now()
  from jsonb_array_elements(p_rows) r
  join au.sos_official_line_map lm
    on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
  group by 1, 2, 3, 4
  -- A cell whose in and out cancel exactly carries no information and would only add a join row.
  having abs(sum((r->>'net_qty')::numeric)) > 1e-9
      or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- anon and authenticated inherit EXECUTE through PUBLIC membership, so revoking only those two is a
-- no-op — the grant has to come off PUBLIC itself. And revoking PUBLIC on a default ACL also strips
-- service_role, which is the one role that must keep it, so it is re-granted explicitly. This is a
-- SECURITY DEFINER function that writes a table feeding every achievement number: a browser role
-- must never reach it.
revoke execute on function public.phx_write_monthly_store_split_net(text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_write_monthly_store_split_net(text, jsonb) to service_role;

-- =====================================================================================================
-- 3. The config fingerprint now covers the split net.
--
--    🔴 LOAD-BEARING. au.f_monthly_achievement serves the precomputed rollup only while the stored
--    fingerprint still equals the live one, and falls back to the live computation otherwise. Without
--    the net in this hash, re-computing a split — a customer reclassified, a distributor added to the
--    wholesale-only registry, an area moved between cities — would leave every covered period serving
--    the OLD attribution with nothing reporting it. The net is small (one row per moved cell per
--    period), so hashing it whole-table is cheap and catches an edit to any period at once.
-- =====================================================================================================
create or replace function au.f_attribution_config_fingerprint()
  returns text
  language sql
  stable parallel safe security definer
  set search_path to 'au', 'public'
as $function$
  select concat_ws('|',
    (select coalesce(sum(hashtextextended(m.*::text,0)),0)::text||':'||count(*)::text||':'||count(*) filter (where m.effective_to is null)::text from au.line_area_map m),
    (select coalesce(sum(hashtextextended(c.*::text,0)),0)::text||':'||count(*)::text from au.sos_area_crosswalk c),
    (select coalesce(sum(hashtextextended(l.*::text,0)),0)::text||':'||count(*)::text from au.sos_official_line_map l),
    (select coalesce(sum(hashtextextended(p.*::text,0)),0)::text||':'||count(*)::text from public.source_of_sales_products p),
    (select coalesce(sum(hashtextextended(d.*::text,0)),0)::text||':'||count(*)::text from au.direct_region_allocation d),
    -- computed_at is deliberately EXCLUDED from the hash: re-writing an identical split must not
    -- invalidate every period's rollup and force a full rebuild for no change in the numbers.
    (select coalesce(sum(hashtextextended((s.period, s.line_code, s.area_code, s.product_code, s.net_qty, s.net_effective_units)::text,0)),0)::text||':'||count(*)::text from au.monthly_store_split_net s)
  );
$function$;

-- =====================================================================================================
-- 4. Attribution applies the net.
--
--    Only the INDIRECT branch changes. Direct rows are excluded from the city split by construction
--    (isSplitEligible returns false for them), they carry no customer to classify, and their money is
--    allocated by au.direct_region_allocation instead — so dir_agg, the direct-region branch and the
--    unmapped branch are byte-for-byte what they were.
--
--    ind_agg is restructured from `sum(effective_units * factory_price)` to `sum(effective_units)`
--    priced once at the end. That is an algebraic identity here, not a behaviour change: the group is
--    keyed by product_code and factory_price is a pure function of product_code with no duplicate
--    rows in source_of_sales_products (verified above). It is needed because the net has to be added
--    to the UNITS before they are priced.
--
--    The join to the net is a FULL one, expressed as a union of keys. An inner join would silently
--    drop exactly the cells this change exists to create — Cairo receiving a Qalubeya wholesaler's
--    share when Cairo has no invoice of its own for that product.
-- =====================================================================================================
create or replace function au.f_monthly_attribution(p_period text)
  returns table(
    period text, channel text, line_code text, region_code text, area_code text, area_state text,
    is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
    product_code text, sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text
  )
  language plpgsql
  stable parallel safe security definer
  set search_path to 'au', 'public'
as $function$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with fact as (
    select f.official_line,
           f.region_code as sos_region_code,
           nullif(btrim(f.area_code),'') as sos_area_code,
           upper(btrim(coalesce(f.product_code,''))) as product_code,
           f.is_direct, f.total_qty, f.effective_units, f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  ),
  priced as (
    select fa.sos_region_code, fa.product_code, fa.is_direct, fa.total_qty, fa.effective_units,
           fa.direct_value, lm.line_code, cw.canonical_area_code,
           coalesce(pp.factory_price,0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp on upper(btrim(pp.product_code)) = fa.product_code
  ),
  alloc as (
    select a.line_code, a.sos_region_code, a.target_region_code,
           a.weight / sum(a.weight) over (partition by a.line_code, a.sos_region_code) as share
    from au.direct_region_allocation a
  ),
  lam_asof as materialized (
    select l.line_code, l.area_code, l.operational_region_code, l.area_state, l.other_type,
           l.dm_seat_id, l.rep_seat_id,
           au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
           au.f_seat_occupant_asof(l.dm_seat_id, v_period_end) as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  -- The indirect money as it sits on the invoices, units kept separate from price.
  ind_base as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q,
           sum(pr.effective_units) as eu
    from priced pr
    where not pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  ),
  -- The wholesaler city split for this period, as the application computed it. Empty for any period
  -- or line the split does not touch, which makes this whole branch a no-op there.
  split as (
    select s.line_code, s.area_code, s.product_code, s.net_qty, s.net_effective_units
    from au.monthly_store_split_net s
    where s.period = p_period
  ),
  -- EVERY column here is table-qualified, and that is not style. This function's RETURNS TABLE
  -- declares OUT parameters called line_code / area_code / product_code, so those names are also
  -- PL/pgSQL variables: a bare `select line_code from ind_base` raises 42702 "column reference is
  -- ambiguous" at run time, not at create time. The original body never tripped it because it
  -- qualified everything; this CTE was the first place that did not, and staging caught it.
  ind_keys as (
    select b.line_code, b.canonical_area_code as area_code, b.product_code from ind_base b
    union
    select s.line_code, s.area_code, s.product_code from split s
  ),
  ind_agg as (
    select k.line_code,
           k.area_code as canonical_area_code,
           k.product_code,
           coalesce(b.q, 0) + coalesce(s.net_qty, 0) as q,
           (coalesce(b.eu, 0) + coalesce(s.net_effective_units, 0)) * coalesce(pp.factory_price, 0) as v
    from ind_keys k
    left join ind_base b
      on b.line_code = k.line_code and b.canonical_area_code = k.area_code and b.product_code = k.product_code
    left join split s
      on s.line_code = k.line_code and s.area_code = k.area_code and s.product_code = k.product_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = k.product_code
  ),
  dir_agg as (
    select pr.line_code, pr.canonical_area_code, pr.product_code,
           sum(pr.total_qty) as q, sum(pr.direct_value) as v
    from priced pr
    where pr.is_direct and pr.line_code is not null and pr.canonical_area_code is not null
    group by pr.line_code, pr.canonical_area_code, pr.product_code
  )
  select p_period, 'indirect'::text, lam.line_code, lam.operational_region_code, lam.area_code,
         lam.area_state, (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
         lam.dm_seat_id, lam.dm_occupant_hr_id, ia.product_code, ia.q, ia.v, true, null::text
  from ind_agg ia
  join lam_asof lam on lam.line_code = ia.line_code and lam.area_code = ia.canonical_area_code

  union all
  select p_period, 'direct'::text, lam.line_code, lam.operational_region_code, lam.area_code,
         lam.area_state, (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
         lam.dm_seat_id, lam.dm_occupant_hr_id, da.product_code, da.q, da.v, true, null::text
  from dir_agg da
  join lam_asof lam on lam.line_code = da.line_code and lam.area_code = da.canonical_area_code

  union all
  select p_period, 'direct'::text, pr.line_code,
         coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')),
         null, null, false, null, null, null, null, pr.product_code,
         sum(pr.total_qty * coalesce(alloc.share, 1)),
         sum(pr.direct_value * coalesce(alloc.share, 1)), true, null::text
  from priced pr
  left join lam_asof lam on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  left join alloc on alloc.line_code = pr.line_code
                 and alloc.sos_region_code = coalesce(nullif(pr.sos_region_code,''), 'NATIONAL')
  where pr.is_direct and pr.line_code is not null
    and (pr.canonical_area_code is null or lam.line_code is null)
  group by pr.line_code,
           coalesce(alloc.target_region_code, coalesce(nullif(pr.sos_region_code,''),'NATIONAL')),
           pr.product_code

  union all
  select p_period, 'unmapped'::text, pr.line_code, null, pr.canonical_area_code, null, false,
         null, null, null, null, pr.product_code,
         sum(pr.total_qty),
         sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
         false,
         case when pr.line_code is null then 'unmapped_line'
              when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
              when (not pr.is_direct) then 'no_area_map'
              else 'unmapped_other' end
  from priced pr
  left join lam_asof lam on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  where pr.line_code is null
     or ((not pr.is_direct) and (pr.canonical_area_code is null or lam.line_code is null))
  group by pr.line_code, pr.canonical_area_code, pr.is_direct,
           case when pr.line_code is null then 'unmapped_line'
                when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
                when (not pr.is_direct) then 'no_area_map'
                else 'unmapped_other' end,
           pr.product_code;
end;
$function$;

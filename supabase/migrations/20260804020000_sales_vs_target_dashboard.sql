-- ─────────────────────────────────────────────────────────────────────────────
-- Sales vs Target dashboard — multi-period read + brick-grain drill-down.
--
-- Two new read paths, both strict refinements of the engine that already serves
-- /sales/targets and the Monthly Closing surfaces. Nothing here re-derives sales or
-- achievement: f_sales_vs_target_range CALLS au.f_monthly_achievement once per period,
-- so a number on this dashboard can never disagree with the same number on Targets.
-- That reuse is the whole point — a second, parallel definition of "achievement" is
-- exactly how two surfaces start quoting different figures for the same month.
--
-- 1. au.f_sales_vs_target_range(p_from, p_to)
--    Period-over-period in ONE round trip instead of N. Hard-floored at 2026-07 (the
--    owner's start month) IN SQL rather than in the app, so no caller — page, API route
--    or future script — can read a pre-July month by passing an earlier period.
--
-- 2. au.f_sales_brick_detail(p_period)
--    The grain f_monthly_attribution aggregates away. A medical rep owns bricks, not
--    areas, so the rep-level drill-down needs this. Verified on production 2026-08-04
--    for 2026-07: 141 (line, area) pairs, ZERO mismatched, brick total 2,800,202.85 =
--    attribution total 2,800,202.85, diff 0.00. It applies the same four filters as
--    f_monthly_attribution (validated batches only, confidential products stripped,
--    official-line map, as-of line/area map) — drop any one and the totals diverge.
--
-- Direct-order rows that do not resolve to an area are attributed at REGION level by
-- f_monthly_attribution and carry no brick by construction, so they are absent from the
-- brick view rather than silently folded into one. The caller shows them separately.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Multi-period achievement ──────────────────────────────────────────────

create or replace function au.f_sales_vs_target_range(p_from text, p_to text)
returns table(
  period text, line_code text, region_code text, area_code text, area_state text,
  is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
  product_code text, actual_units numeric, actual_value numeric,
  target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric,
  has_target boolean, has_actual boolean
)
language plpgsql
stable
security definer
set search_path to 'au', 'public'
as $function$
declare
  -- The dashboard's start month. Owner decision 2026-08-04: this dashboard begins at
  -- July 2026 and never reads earlier, even though May/June 2026 SoS data exists. July
  -- therefore reports "no prior period" rather than silently comparing to June.
  v_floor  constant date := date '2026-07-01';
  -- Each period costs one full attribution pass (~128ms on 2026-07 production volume).
  -- 24 months bounds a malformed or hostile range; the UI never asks for more.
  v_max_months constant int := 24;
  v_from date;
  v_to   date;
begin
  if p_from !~ '^\d{4}-\d{2}$' or p_to !~ '^\d{4}-\d{2}$' then
    return;
  end if;

  v_from := greatest(date_trunc('month', to_date(p_from || '-01', 'YYYY-MM-DD'))::date, v_floor);
  v_to   := date_trunc('month', to_date(p_to || '-01', 'YYYY-MM-DD'))::date;

  if v_to < v_from then
    return;
  end if;

  v_to := least(v_to, (v_from + make_interval(months => v_max_months - 1))::date);

  return query
  -- g.d comes back as timestamptz; ::date before to_char so the period label is a pure
  -- calendar month and cannot be shifted by whatever TimeZone the session happens to run.
  select a.*
  from generate_series(v_from, v_to, interval '1 month') g(d)
  cross join lateral au.f_monthly_achievement(to_char(g.d::date, 'YYYY-MM')) a;
end;
$function$;

-- ── 2. Brick-grain sales ─────────────────────────────────────────────────────

create or replace function au.f_sales_brick_detail(p_period text)
returns table(
  period text, line_code text, region_code text, area_code text, area_state text,
  rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
  brick_id text, brick_name text, block_code text,
  sales_units numeric, sales_value numeric, direct_value numeric, indirect_value numeric
)
language plpgsql
stable
security definer
set search_path to 'au', 'public'
as $function$
declare
  v_period_end date;
begin
  if p_period !~ '^\d{4}-\d{2}$' then
    return;
  end if;
  -- Pre-July periods carry no dashboard meaning; refuse rather than serve them.
  if to_date(p_period || '-01', 'YYYY-MM-DD') < date '2026-07-01' then
    return;
  end if;

  v_period_end := (date_trunc('month', to_date(p_period || '-01', 'YYYY-MM-DD'))
                   + interval '1 month - 1 day')::date;

  return query
  with fact as (
    select
      f.official_line,
      -- Direct rows carry area_code = '' (empty string), NEVER null. An `is null` test
      -- here sends every direct row down the wrong branch; nullif is what
      -- f_monthly_attribution uses and what makes the two reconcile.
      nullif(btrim(f.area_code), '')            as sos_area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '') as brick_id,
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  priced as (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(pp.factory_price, 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = fa.product_code
  ),
  lam_asof as materialized (
    select
      l.line_code, l.area_code, l.operational_region_code, l.area_state,
      l.dm_seat_id, l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  )
  select
    p_period,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.brick_id,
    -- Null name is meaningful and must survive to the caller: a row with no brick_id at
    -- all is real sales inside the area (10,772.98 EGP across 73 rows in 2026-07) that
    -- the UI shows as "No brick recorded" rather than dropping or mislabelling as a code.
    b.brick_name,
    b.block_code,
    sum(pr.total_qty),
    sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
    sum(case when pr.is_direct then pr.direct_value else 0 end),
    sum(case when pr.is_direct then 0 else pr.effective_units * pr.factory_price end)
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  left join public.source_of_sales_bricks b
    on b.brick_id = pr.brick_id
  where pr.line_code is not null and pr.canonical_area_code is not null
  group by
    lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
    lam.rep_seat_id, lam.rep_occupant_hr_id, lam.dm_seat_id, lam.dm_occupant_hr_id,
    pr.brick_id, b.brick_name, b.block_code;
end;
$function$;

-- ── 3. PostgREST-reachable wrappers ──────────────────────────────────────────
-- au is not exposed to PostgREST, so the app reaches these through public.phx_*.

create or replace function public.phx_sales_vs_target_range(p_from text, p_to text)
returns table(
  period text, line_code text, region_code text, area_code text, area_state text,
  is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
  product_code text, actual_units numeric, actual_value numeric,
  target_units numeric, target_value numeric,
  achievement_value numeric, achievement_units numeric,
  has_target boolean, has_actual boolean
)
language sql
stable
security definer
set search_path to 'au', 'public'
as $function$ select * from au.f_sales_vs_target_range(p_from, p_to); $function$;

create or replace function public.phx_sales_brick_detail(p_period text)
returns table(
  period text, line_code text, region_code text, area_code text, area_state text,
  rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text,
  brick_id text, brick_name text, block_code text,
  sales_units numeric, sales_value numeric, direct_value numeric, indirect_value numeric
)
language sql
stable
security definer
set search_path to 'au', 'public'
as $function$ select * from au.f_sales_brick_detail(p_period); $function$;

-- ── 4. Grants ────────────────────────────────────────────────────────────────
-- PUBLIC is the operative grantee: every login role (anon, authenticated) inherits EXECUTE
-- through PUBLIC membership, so revoking only those two would be a no-op. REVOKE EXECUTE
-- (not REVOKE ALL) is the post-20260719170000 convention the migrations guard enforces.
--
-- REVOKE ... FROM PUBLIC also strips service_role while the function still carries the
-- default ACL, so every revoke below is paired with an explicit grant. Verify with
-- has_function_privilege('service_role', '<fn>(text)', 'EXECUTE') after applying.

revoke execute on function au.f_sales_vs_target_range(text, text) from public, anon, authenticated;
revoke execute on function public.phx_sales_vs_target_range(text, text) from public, anon, authenticated;
revoke execute on function au.f_sales_brick_detail(text) from public, anon, authenticated;
revoke execute on function public.phx_sales_brick_detail(text) from public, anon, authenticated;

grant execute on function au.f_sales_vs_target_range(text, text) to service_role;
grant execute on function public.phx_sales_vs_target_range(text, text) to service_role;
grant execute on function au.f_sales_brick_detail(text) to service_role;
grant execute on function public.phx_sales_brick_detail(text) to service_role;

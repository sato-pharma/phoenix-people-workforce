-- ─────────────────────────────────────────────────────────────────────────────
-- au.f_monthly_achievement: a hashable join key removes two nested-loop rejoins.
--
-- The function rejoined `keys` back to `actuals` and `tgt` with four-column
-- IS NOT DISTINCT FROM predicates. Those were made NULL-safe deliberately (on
-- 2026-08-01 and 2026-08-12 — see 20260801150100_au_direct_counts_toward_achievement
-- and 20260812150000_au_achievement_counts_unmapped_sales) so a sale carrying no
-- line / no area / no product is not zeroed out. But PostgreSQL cannot hash or
-- merge IS NOT DISTINCT FROM, so each rejoin degraded to a nested loop that
-- cross-compared every `keys` row against every actuals/tgt row. Measured on
-- production for 2026-07 (EXPLAIN ANALYZE):
--
--     left join actuals ac : Rows Removed by Join Filter 847,356  (~280 ms)
--     left join tgt   tg   : Rows Removed by Join Filter 702,756  (~230 ms)
--
-- ~510 ms per month of pure NULL-safe text comparison, on top of the
-- f_monthly_attribution floor. f_monthly_achievement ran 848 ms; the range
-- reporter au.f_sales_vs_target_range (public.phx_sales_vs_target_range) calls it
-- once per month, so a two-month view cost ~1.2 s and a wide multi-month view up
-- to 7 s (production pg_stat_statements: 2,752,709 ms / 2,261 calls = 1,217 ms
-- mean, 7,044 ms max, 7.0% of all database time).
--
-- Fix: fold the four key columns into one delimiter-joined text `join_key` — NULLs
-- mapped to chr(30), fields separated by chr(31), both control characters that
-- never occur in a line / area / region / product code — and rejoin on plain `=`.
-- This is exactly NULL-safe-equal: two rows share a join_key iff all four columns
-- are pairwise IS NOT DISTINCT FROM, because the marker can never equal a real
-- code and the delimiter can never appear inside one. The planner is then free to
-- hash/merge. Measured after: 848 ms -> 351 ms per month (the residual is the
-- attribution floor); the two rejoins drop from ~510 ms to ~26 ms combined.
--
-- Output is unchanged to the piastre. Verified on production 2026-08-14 against
-- the live function for both data months, full 19-column rows compared both ways
-- with EXCEPT: 2026-07 965 rows, 2026-08 669 rows, zero symmetric difference.
--
-- Preserved verbatim: the channel filter stays absent, direct_region_code and its
-- grouping, region_dm, the rep columns reading from lam alone, the strict `=` seat
-- join (an unplaced row reaches no rep), and has_actual off coalesce(ac.matched).
--
-- PARALLEL SAFE is re-declared on purpose. The live function is
-- STABLE PARALLEL SAFE (20260814003000_pg_health_parallel_safe_reporting_chain
-- marked it so); CREATE OR REPLACE resets any unstated characteristic to its
-- default, so omitting `parallel safe` here would silently regress it to
-- PARALLEL UNSAFE and undo that change. It is a read-only reporter and does no
-- writes, so the marking is correct.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function au.f_monthly_achievement(p_period text)
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
parallel safe
security definer
set search_path to 'au', 'public'
as $function$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with attribution as (
    -- No channel filter. Every row the engine emits is a sale that happened; the ones
    -- it could not place are reported as unplaced, never dropped.
    select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
    from au.f_monthly_attribution(p_period) a
  ),
  actuals as (
    select
      at.line_code,
      at.area_code,
      case when at.area_code is null then at.region_code end as direct_region_code,
      at.product_code,
      sum(at.sales_units) as actual_units,
      sum(at.sales_value) as actual_value,
      true as matched,
      -- One hashable key standing in for the four-column NULL-safe match below.
      -- chr(30) marks a NULL, chr(31) separates fields; neither occurs in a code,
      -- so equal join_key <=> all four columns pairwise IS NOT DISTINCT FROM.
      concat_ws(chr(31),
        coalesce(at.line_code, chr(30)),
        coalesce(at.area_code, chr(30)),
        coalesce(case when at.area_code is null then at.region_code end, chr(30)),
        coalesce(at.product_code, chr(30))) as join_key
    from attribution at
    group by at.line_code, at.area_code,
             case when at.area_code is null then at.region_code end,
             at.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, null::text as direct_region_code,
           t.product_code, t.target_units, t.target_value,
      concat_ws(chr(31),
        coalesce(t.line_code, chr(30)),
        coalesce(t.area_code, chr(30)),
        coalesce(null::text, chr(30)),
        coalesce(t.product_code, chr(30))) as join_key
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.join_key, actuals.line_code, actuals.area_code, actuals.direct_region_code, actuals.product_code from actuals
    union
    select tgt.join_key, tgt.line_code, tgt.area_code, tgt.direct_region_code, tgt.product_code from tgt
  ),
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  ),
  region_dm as (
    select
      lam.line_code,
      lam.operational_region_code,
      min(lam.dm_seat_id)          as dm_seat_id,
      min(lam.dm_occupant_hr_id)   as dm_occupant_hr_id
    from lam_asof lam
    where lam.operational_region_code is not null
    group by lam.line_code, lam.operational_region_code
  )
  select
    p_period,
    k.line_code,
    coalesce(lam.operational_region_code, k.direct_region_code),
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    coalesce(lam.dm_seat_id, rdm.dm_seat_id),
    coalesce(lam.dm_occupant_hr_id, rdm.dm_occupant_hr_id),
    k.product_code,
    coalesce(ac.actual_units, 0), coalesce(ac.actual_value, 0),
    tg.target_units, tg.target_value,
    case when tg.target_value is not null and tg.target_value <> 0
         then coalesce(ac.actual_value, 0) / tg.target_value end,
    case when tg.target_units is not null and tg.target_units <> 0
         then coalesce(ac.actual_units, 0) / tg.target_units end,
    (tg.line_code is not null),
    coalesce(ac.matched, false)
  from keys k
  left join actuals ac
    on ac.join_key = k.join_key
  left join tgt tg
    on tg.join_key = k.join_key
  left join lam_asof lam
    on lam.line_code = k.line_code
   and lam.area_code = k.area_code
  left join region_dm rdm
    on rdm.line_code = k.line_code
   and rdm.operational_region_code = k.direct_region_code;
end;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, but re-declaring it costs nothing and
-- documents the intent. REVOKE ... FROM PUBLIC on a default ACL strips service_role
-- along with it, so the grant below is mandatory, not decorative.
revoke execute on function au.f_monthly_achievement(text) from public, anon, authenticated;
grant execute on function au.f_monthly_achievement(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- au.f_sales_vs_target_range — drop the hard floor from 2026-07-01 to 2026-01-01.
--
-- WHY: two different facts had been collapsed into one constant.
--
--   * THE DASHBOARD'S START MONTH (owner decision, 2026-08-04) — /sales-vs-target opens
--     at July 2026 and never offers an earlier month in its picker, so July reports "no
--     prior period" rather than silently comparing itself to June. That decision is NOT
--     reversed here. It lives in TypeScript as SALES_VS_TARGET_FLOOR ("2026-07") and is
--     still applied by loadVsTargetRange / isValidVsTargetPeriod before the range call is
--     ever made.
--
--   * THE ENGINE'S DATA FLOOR — the earliest month Source of Sales actually holds. That
--     is 2026-01: verified live on production for this change, six consecutive months of
--     canonical attribution, Jan–Jun 2026:
--
--         2026-01  anti_infective    836,628.75    cns  5,653,968.28   pedia  1,319,482.60
--         2026-02  anti_infective    811,063.85    cns  8,514,910.94   pedia  2,055,319.56
--         2026-03  anti_infective    845,179.23    cns  6,168,996.99   pedia  2,384,780.13
--         2026-04  anti_infective    757,642.74    cns  6,677,387.13   pedia  2,141,289.29
--         2026-05  anti_infective    756,056.55    cns  8,362,730.04   pedia  2,727,075.14
--         2026-06  anti_infective  1,021,155.60    cns  4,114,793.18   pedia  4,231,982.29
--
-- Because the two were one constant, every surface that legitimately reports HISTORY —
-- employee-360, the monthly dashboard, the admin KPI, reconciliation, and the S1 Business
-- Review — had no way to read a pre-July month from the canonical engine at all. Each of
-- them stayed on the legacy `sales_records` table instead, which is exactly the two-engine
-- split that Rule #1 (SoS Monthly Closing is the only sales truth) exists to end. The
-- clamp silently returned an empty range rather than erroring, so the divergence never
-- announced itself.
--
-- au.f_monthly_achievement — the function this one calls once per period — has never had a
-- floor and already answers correctly for pre-July months. This change removes a wrapper's
-- clamp; it does not widen what the engine can compute, and it changes NO number that any
-- current caller already reads: every period >= 2026-07 returns byte-identical rows.
--
-- Policy now lives in TypeScript (SALES_VS_TARGET_FLOOR for the dashboard,
-- SALES_HISTORY_FLOOR for history surfaces); this floor stays only as the hard data bound
-- a caller cannot widen by passing an earlier `p_from`.
--
-- au.f_sales_brick_detail keeps its own 2026-07-01 refusal, deliberately. Brick-grain
-- drill-down is the /sales-vs-target dashboard's own feature and has no pre-July consumer;
-- widening it would load a grain nothing renders.
--
-- Body is otherwise verbatim: same signature, same volatility, same security_definer, same
-- search_path. Grants are unchanged by CREATE OR REPLACE and are re-asserted below anyway,
-- because REVOKE ... FROM PUBLIC strips service_role while the default ACL is in place.
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- The engine's DATA floor — the first month Source of Sales holds — not a policy floor.
  -- /sales-vs-target's July start month is enforced in TypeScript before the call.
  v_floor  constant date := date '2026-01-01';
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

-- ── Grants ───────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves the existing ACL, so these are re-assertions rather than
-- changes. Kept because REVOKE ... FROM PUBLIC strips service_role on a default ACL, and a
-- future replace that omitted them would leave the function unreachable by the app.

revoke execute on function au.f_sales_vs_target_range(text, text) from public, anon, authenticated;
grant execute on function au.f_sales_vs_target_range(text, text) to service_role;

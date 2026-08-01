-- Analytics and the Source of Sales dashboard must report the same number.
--
-- They do not today. analytics.sos_fact hard-excludes products LA003/LA004/SS001 in the view body,
-- while the SoS dashboard includes them behind a CEO/Super-Admin reveal. Measured on production:
--
--     period    analytics.sos_fact      sos_fact_all             delta
--     2026-01        7,747,839               39,699,493      -31,951,654
--     2026-02       11,384,570               32,230,122      -20,845,552
--     2026-03        9,400,846               64,893,123      -55,492,277
--     2026-04        9,197,842               40,552,346      -31,354,505
--     2026-06        9,362,810               53,894,769      -44,531,959
--
-- In every month the delta is EXACTLY the LA003/LA004/SS001 total (verified: the non-confidential
-- subtotal of sos_fact_all equals sos_fact to the digit in all five months, and the row counts
-- reconcile — 158,277 - 94,152 = 64,125 = the confidential row count). Those three products are
-- 64.7%-85.5% of company value, so Analytics is not showing a filtered view of sales; it is showing
-- the minority remainder, and June reads 5.76x smaller than the same month on the dashboard.
--
-- Head Office is NOT the same problem: it is already a per-caller reveal (p_exclude_head_office /
-- stripHeadOfficeRows, gated on canViewHeadOfficeLine = CEO/Super Admin). Confidential products were
-- the one lock with no way to reveal, so the divergence is CEO/Super-Admin-only — which is exactly
-- who reported it. A non-privileged viewer already agrees with the dashboard and must keep agreeing.
--
-- Owner decision: Analytics adopts the dashboard's rule — hidden by default, revealed only for
-- CEO / Super Admin. The view that includes them already exists (analytics.sos_fact_all, column list
-- identical to sos_fact), so this is a filter change, not a data rebuild.
--
-- ── WHY THIS FILE WAS REWRITTEN ─────────────────────────────────────────────────────────────────
-- The first version was authored against an OLDER shape of these functions and would have silently
-- corrupted Analytics: it dropped `channel` from analytics_sos_by_period and analytics_sos_by_area,
-- and `bonus_units` from by_period, while mapSosKpiRow/mapSosAreaRow read r.channel and
-- r.bonus_units. Those mappers coerce a missing column to ""/0, so it degrades silently instead of
-- failing. It also replaced the head-office predicate with a weaker one that lost both the
-- whitespace normalisation and the 'office' spelling — a confidentiality regression.
--
-- Every function body below is therefore copied VERBATIM from the live production definition. The
-- only edits are: sos_fact -> sos_fact_all, the new p_exclude_codes parameter, and its predicate.
-- If you change these bodies again, diff pg_get_function_result() before and after — comparing
-- aggregate totals cannot see a dropped dimension column, which is how the first version passed a
-- staging check.
--
-- Adding an argument creates an OVERLOAD rather than replacing the function, and an orphaned
-- analytics_* overload is exactly what left company-wide SoS data anon-readable before
-- (20260719160500). Every function is DROPped at its exact current signature first, then recreated,
-- then re-revoked. The exclusion predicate matches sos_fact's own:
-- upper(btrim(coalesce(product_code,''))) <> ALL (...).

begin;

-- ── analytics_sos_by_period ──────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_period(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean);

create function public.analytics_sos_by_period(
  p_periods              text[]  default null,
  p_period_from          text    default null,
  p_period_to            text    default null,
  p_channels             text[]  default null,
  p_lines                text[]  default null,
  p_distributors         text[]  default null,
  p_regions              text[]  default null,
  p_areas                text[]  default null,
  p_products             text[]  default null,
  p_families             text[]  default null,
  p_client_codes         text[]  default null,
  p_exclude_head_office  boolean default true,
  p_exclude_codes        text[]  default array['LA003','LA004','SS001']
)
returns table(period text, year integer, month integer, channel text, units numeric, bonus_units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, channel,
         sum(units)       as units,
         sum(bonus_units) as bonus_units,
         sum(value)       as value
  from   analytics.sos_fact_all
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code, ''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, channel
  order by period, channel;
$function$;

-- ── analytics_sos_by_area ────────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_area(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean);

create function public.analytics_sos_by_area(
  p_periods              text[]  default null,
  p_period_from          text    default null,
  p_period_to            text    default null,
  p_channels             text[]  default null,
  p_lines                text[]  default null,
  p_distributors         text[]  default null,
  p_regions              text[]  default null,
  p_areas                text[]  default null,
  p_products             text[]  default null,
  p_families             text[]  default null,
  p_client_codes         text[]  default null,
  p_exclude_head_office  boolean default true,
  p_exclude_codes        text[]  default array['LA003','LA004','SS001']
)
returns table(period text, year integer, month integer, region_code text, region_name text,
              area_code text, area_name text, channel text, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, region_code, region_name, area_code, area_name, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code, ''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name;
$function$;

-- ── analytics_sos_by_line ────────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[]);

create function public.analytics_sos_by_line(
  p_periods       text[] default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_channels      text[] default null,
  p_lines         text[] default null,
  p_distributors  text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null,
  p_products      text[] default null,
  p_families      text[] default null,
  p_client_codes  text[] default null,
  p_exclude_codes text[] default array['LA003','LA004','SS001']
)
returns table(period text, year integer, month integer, line text, channel text,
              units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code, ''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, line, channel
  order by period, value desc;
$function$;

-- ── analytics_sos_by_product ─────────────────────────────────────────────────
drop function if exists public.analytics_sos_by_product(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[]);

create function public.analytics_sos_by_product(
  p_periods       text[] default null,
  p_period_from   text   default null,
  p_period_to     text   default null,
  p_channels      text[] default null,
  p_lines         text[] default null,
  p_distributors  text[] default null,
  p_regions       text[] default null,
  p_areas         text[] default null,
  p_products      text[] default null,
  p_families      text[] default null,
  p_client_codes  text[] default null,
  p_exclude_codes text[] default array['LA003','LA004','SS001']
)
returns table(period text, year integer, month integer, product_code text, product_name text,
              family text, family_code text, line text, channel text, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, product_code, product_name, family, family_code, line, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null    or period = any(p_periods))
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channels is null    or channel = any(p_channels))
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code, ''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, product_code, product_name, family, family_code, line, channel
  order by period, value desc;
$function$;

-- ── ACLs ─────────────────────────────────────────────────────────────────────
-- These read confidential product value, so PUBLIC/anon/authenticated EXECUTE must be revoked on
-- every one. A CREATE carries the built-in PUBLIC EXECUTE grant; leaving it is precisely how
-- analytics SoS data became anon-readable before (see 20260719160500).
revoke execute on function public.analytics_sos_by_period(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[])
  from public, anon, authenticated;
revoke execute on function public.analytics_sos_by_area(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[])
  from public, anon, authenticated;
revoke execute on function public.analytics_sos_by_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[])
  from public, anon, authenticated;
revoke execute on function public.analytics_sos_by_product(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[])
  from public, anon, authenticated;

grant execute on function public.analytics_sos_by_period(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[])
  to service_role;
grant execute on function public.analytics_sos_by_area(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[])
  to service_role;
grant execute on function public.analytics_sos_by_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[])
  to service_role;
grant execute on function public.analytics_sos_by_product(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], text[])
  to service_role;

commit;

notify pgrst, 'reload schema';

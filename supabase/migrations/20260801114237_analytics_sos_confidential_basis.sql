-- Analytics and the Source of Sales dashboard must report the same number.
--
-- They do not today. analytics.sos_fact hard-excludes products LA003/LA004/SS001, while the SoS
-- dashboard includes them behind a CEO/Super-Admin reveal. Measured on production 2026-07-31:
--
--     period    analytics.sos_fact      raw / SoS dashboard        delta
--     2026-01        7,747,839               39,699,493      -31,951,654
--     2026-02       11,384,570               32,230,122      -20,845,552
--     2026-03        9,400,846               64,893,123      -55,492,277
--     2026-04        9,197,842               40,552,346      -31,354,504
--     2026-06        9,362,810               53,894,769      -44,531,959
--
-- In every month the delta is EXACTLY the LA003/LA004/SS001 total. Those three products are
-- 64.7%-85.5% of company value, so Analytics is not showing a filtered view of sales — it is showing
-- the minority remainder, and June reads 5.76x smaller than the same month on the dashboard.
--
-- Owner decision (2026-07-31): Analytics adopts the SoS dashboard's rule — confidential products are
-- hidden by default and revealed only for CEO / Super Admin. One number, one rule, everywhere.
--
-- The view that includes them already exists: analytics.sos_fact_all, whose column list is identical
-- to analytics.sos_fact (verified on production). So this is a filter change, not a data rebuild:
-- the four analytics_sos_by_* RPCs now read sos_fact_all and take the exclusion as an ARGUMENT,
-- exactly as the phx_exec_* family already does. The default keeps today's behaviour for any caller
-- that does not pass one, so an un-updated caller stays fail-closed.
--
-- SCOPE NOTE: this migration deliberately does NOT add p_exclude_head_office to _by_line/_by_product.
-- That asymmetry is real but is currently covered fail-closed in TypeScript by stripHeadOfficeRows
-- (src/lib/analytics/service.ts), and folding a second DROP/CREATE reason into this migration would
-- widen the blast radius of a change that already touches four SECURITY DEFINER functions. It is
-- tracked separately.
--
-- Adding an argument creates an OVERLOAD rather than replacing the function, and an orphaned
-- analytics_* overload is exactly what left company-wide SoS data anon-readable before
-- (20260719160500). Every function below is therefore DROPped at its exact current signature first,
-- then recreated, then re-revoked.

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
returns table(period text, year integer, month integer, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null      or period = any(p_periods))
    and  (p_period_from is null  or period >= p_period_from)
    and  (p_period_to   is null  or period <= p_period_to)
    and  (p_channels is null     or channel = any(p_channels))
    and  (p_lines is null        or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null      or region_code = any(p_regions))
    and  (p_areas is null        or area_code = any(p_areas))
    and  (p_products is null     or product_code = any(p_products))
    and  (p_families is null     or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office or lower(coalesce(line,'')) not in ('head office','headoffice','hq'))
    -- Case/whitespace-normalised on BOTH sides — the same normalisation 20260719153000 introduced,
    -- so a stored 'la003' cannot slip past the exclusion.
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code,''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month
  order by period;
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
              area_code text, area_name text, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, region_code, region_name, area_code, area_name,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact_all
  where  (p_periods is null      or period = any(p_periods))
    and  (p_period_from is null  or period >= p_period_from)
    and  (p_period_to   is null  or period <= p_period_to)
    and  (p_channels is null     or channel = any(p_channels))
    and  (p_lines is null        or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null      or region_code = any(p_regions))
    and  (p_areas is null        or area_code = any(p_areas))
    and  (p_products is null     or product_code = any(p_products))
    and  (p_families is null     or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (not p_exclude_head_office or lower(coalesce(line,'')) not in ('head office','headoffice','hq'))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code,''))) <> all (
               select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, region_code, region_name, area_code, area_name
  order by period, value desc;
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
  where  (p_periods is null      or period = any(p_periods))
    and  (p_period_from is null  or period >= p_period_from)
    and  (p_period_to   is null  or period <= p_period_to)
    and  (p_channels is null     or channel = any(p_channels))
    and  (p_lines is null        or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null      or region_code = any(p_regions))
    and  (p_areas is null        or area_code = any(p_areas))
    and  (p_products is null     or product_code = any(p_products))
    and  (p_families is null     or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code,''))) <> all (
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
  where  (p_periods is null      or period = any(p_periods))
    and  (p_period_from is null  or period >= p_period_from)
    and  (p_period_to   is null  or period <= p_period_to)
    and  (p_channels is null     or channel = any(p_channels))
    and  (p_lines is null        or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null      or region_code = any(p_regions))
    and  (p_areas is null        or area_code = any(p_areas))
    and  (p_products is null     or product_code = any(p_products))
    and  (p_families is null     or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    and  (p_exclude_codes is null
          or upper(btrim(coalesce(product_code,''))) <> all (
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

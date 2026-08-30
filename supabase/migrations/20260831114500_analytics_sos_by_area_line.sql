-- Analytics: expose the LINE alongside the area breakdown.
--
-- WHY. `analytics_sos_by_area` accepts `p_lines` as a filter but does not project `line`, so its
-- rows are aggregated across lines. The organogram region is a function of (line, area, month) —
-- the same area belongs to different DM territories on different lines — so the owning region
-- simply cannot be recovered from that output. Measured on production for 2026-07: EGP 705,076 of
-- 10,370,361 (6.8%) is filed under a region the organogram does not agree with; `OT` is understated
-- by 266,063, and `UE-1` / `UE-2` do not appear at all because no row in the geographic master
-- carries those codes.
--
-- This function is `analytics_sos_by_area` with `line` added to the projection and the GROUP BY.
-- Everything else — every parameter, the Head Office exclusion, the excluded product codes, the
-- security context and the search_path — is byte-for-byte the existing behaviour.
--
-- ADDITIVE ON PURPOSE. `analytics_sos_by_area` is left exactly as it is rather than altered in
-- place. Adding `line` changes the return type, which cannot be done with CREATE OR REPLACE and
-- would need a DROP first — a window in which any caller errors. A new function cannot break a
-- caller that does not know about it, and rolling this back means not calling it. On a database
-- with no point-in-time recovery that difference is the whole argument.
--
-- Grants match the source function exactly: EXECUTE to service_role only. It is deliberately NOT
-- granted to `metabase` or `analytics_readonly`, matching `analytics_sos_by_area`, so this changes
-- nothing about what any external reporting consumer can reach.

create or replace function public.analytics_sos_by_area_line(
  p_periods            text[]  default null,
  p_period_from        text    default null,
  p_period_to          text    default null,
  p_channels           text[]  default null,
  p_lines              text[]  default null,
  p_distributors       text[]  default null,
  p_regions            text[]  default null,
  p_areas              text[]  default null,
  p_products           text[]  default null,
  p_families           text[]  default null,
  p_client_codes       text[]  default null,
  p_exclude_head_office boolean default true,
  p_exclude_codes      text[]  default array['LA003'::text, 'LA004'::text, 'SS001'::text]
)
returns table(
  period      text,
  year        integer,
  month       integer,
  line        text,
  region_code text,
  region_name text,
  area_code   text,
  area_name   text,
  channel     text,
  units       numeric,
  value       numeric
)
language sql
stable
parallel safe
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, year, month, line, region_code, region_name, area_code, area_name, channel,
         sum(units) as units,
         sum(value) as value
  from analytics.sos_fact_all
  where (p_periods is null or period = any(p_periods))
    and (p_period_from is null or period >= p_period_from)
    and (p_period_to is null or period <= p_period_to)
    and (p_channels is null or channel = any(p_channels))
    and (p_lines is null or line = any(p_lines))
    and (p_distributors is null or distributor_code = any(p_distributors))
    and (p_regions is null or region_code = any(p_regions))
    and (p_areas is null or area_code = any(p_areas))
    and (p_products is null or product_code = any(p_products))
    and (p_families is null or family = any(p_families))
    and (p_client_codes is null or client_code = any(p_client_codes))
    and (not p_exclude_head_office
         or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
            not in ('head office', 'headoffice', 'office', 'hq'))
    and (p_exclude_codes is null
         or upper(btrim(coalesce(product_code, '')))
            <> all (select upper(btrim(c)) from unnest(p_exclude_codes) as c))
  group by period, year, month, line, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name, line;
$function$;

-- anon/authenticated inherit EXECUTE via PUBLIC, so revoking only those grantees is a no-op:
-- the revoke has to name PUBLIC itself. Pinned by tests/migrations-secdef-revoke-guard.test.ts.
revoke execute on function public.analytics_sos_by_area_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[]
) from public;

grant execute on function public.analytics_sos_by_area_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[]
) to service_role;

comment on function public.analytics_sos_by_area_line(
  text[], text, text, text[], text[], text[], text[], text[], text[], text[], text[], boolean, text[]
) is
  'analytics_sos_by_area, plus the line. The caller needs the line to resolve the organogram region '
  'for (line, area, period); the region_code returned here is the GEOGRAPHIC one and stays the '
  'dimension every access bound is expressed in.';

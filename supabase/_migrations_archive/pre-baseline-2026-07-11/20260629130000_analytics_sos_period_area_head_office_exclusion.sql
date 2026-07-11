-- Head Office confidential-line exclusion for the two line-LESS SoS aggregate RPCs.
--
-- Background: the Head Office product line is confidential — visible only to CEO /
-- Super Admin (see canViewHeadOfficeLine / isHeadOfficeLine in
-- src/lib/sales/access-scope.ts). Across the sales surfaces (PR #618) the strip is
-- applied in TypeScript via stripHeadOfficeRows() on each row's `line` dimension.
--
-- BUT analytics_sos_by_period and analytics_sos_by_area aggregate AWAY the line — their
-- result rows carry no `line` column — so loadSosByPeriod / loadSosByArea cannot strip
-- Head Office after the fact. The headline KPI total + trend on /admin/analytics/source-sales
-- and .../by-area therefore still folded Head Office sales value into the totals shown to
-- non-CEO roles (e.g. SFE Manager), from which the confidential HO figure is inferable.
--
-- Fix: push the exclusion INSIDE the two RPCs (where the `line` dimension is still present,
-- pre-aggregation) behind a new p_exclude_head_office boolean. The loaders pass
-- !canViewHeadOfficeLine(role): CEO / Super Admin pass false (HO included); everyone else
-- passes true (HO excluded). The param DEFAULTS TO true so any future caller that forgets it
-- fails CLOSED (excludes HO) rather than leaking it.
--
-- The match mirrors isHeadOfficeLine() semantics exactly: trim + collapse inner whitespace +
-- lowercase, then compare to the confidential-line key set ('head office' / 'headoffice' /
-- 'office' / 'hq'). This is line-NAME based (the analytics view's `line` = official_line) and
-- deliberately NOT a TS line-allowlist: the product-master `line` and the analytics view's
-- `line` label can diverge ("Anti Inf" vs "Anti infective"), so an allowlist would over-exclude
-- legitimate lines. No legitimate product line normalizes to the HO key set, so this only ever
-- removes Head Office.

begin;

-- ── SoS by period — drop 11-param signature, re-create with p_exclude_head_office ──

drop function if exists public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]);

create or replace function public.analytics_sos_by_period(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null,
  p_exclude_head_office boolean default true
)
returns table (
  period       text,
  year         integer,
  month        integer,
  channel      text,
  units        numeric,
  bonus_units  numeric,
  value        numeric
)
language sql
stable
security definer
set search_path = analytics, public
as $$
  select period, year, month, channel,
         sum(units)       as units,
         sum(bonus_units) as bonus_units,
         sum(value)       as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    -- Head Office confidential-line floor (mirrors isHeadOfficeLine).
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
  group by period, year, month, channel
  order by period, channel;
$$;

revoke all on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_period(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean) to service_role;

-- ── SoS by area — drop 11-param signature, re-create with p_exclude_head_office ──

drop function if exists public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[]);

create or replace function public.analytics_sos_by_area(
  p_period      text    default null,
  p_period_from text    default null,
  p_period_to   text    default null,
  p_channel     text    default null,
  p_lines       text[]  default null,
  p_distributors text[] default null,
  p_regions     text[]  default null,
  p_areas       text[]  default null,
  p_products    text[]  default null,
  p_families    text[]  default null,
  p_client_codes text[] default null,
  p_exclude_head_office boolean default true
)
returns table (
  period      text,
  year        integer,
  month       integer,
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
security definer
set search_path = analytics, public
as $$
  select period, year, month, region_code, region_name, area_code, area_name, channel,
         sum(units) as units,
         sum(value) as value
  from   analytics.sos_fact
  where  (p_period is null      or period = p_period)
    and  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_channel is null     or channel = p_channel)
    and  (p_lines is null       or line = any(p_lines))
    and  (p_distributors is null or distributor_code = any(p_distributors))
    and  (p_regions is null     or region_code = any(p_regions))
    and  (p_areas is null       or area_code = any(p_areas))
    and  (p_products is null    or product_code = any(p_products))
    and  (p_families is null    or family = any(p_families))
    and  (p_client_codes is null or client_code = any(p_client_codes))
    -- Head Office confidential-line floor (mirrors isHeadOfficeLine).
    and  (not p_exclude_head_office
          or lower(btrim(regexp_replace(coalesce(line, ''), '\s+', ' ', 'g')))
             not in ('head office', 'headoffice', 'office', 'hq'))
  group by period, year, month, region_code, region_name, area_code, area_name, channel
  order by period, region_name, area_name;
$$;

revoke all on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean) from public, anon, authenticated, analytics_readonly;
grant  execute on function public.analytics_sos_by_area(text, text, text, text, text[], text[], text[], text[], text[], text[], text[], boolean) to service_role;

-- Ask PostgREST to reload its schema cache so the new signatures are served immediately.
notify pgrst, 'reload schema';

commit;

-- territory_pharmacy_place_matches
--
-- WHAT THIS CHANGES:
--   1. New table public.territory_pharmacy_place_matches: for one distributor customer (distributor
--      code + customer code), the Google Maps place Phoenix matched it to, or why it did not. It keeps
--      only Google's place id (the one Places value Google's terms let an app keep) and Phoenix's own
--      search text and verdict. RLS on, no policy, server only.
--   2. New function phx_territory_pharmacies_to_match: the drilldown pharmacies ranked by sales value
--      over the given months, down to a share of the total (0.8 = the pharmacies carrying 80% of
--      sales), with each one's name and brick centre, skipping any already looked up.
--   The drilldown reads the matched place ids from this table directly (pharmacy-directions-sources.ts),
--   so phx_territory_area_pharmacy_locations is left exactly as it is.
-- WHY: owner, 2026-11-27: the drilldown pharmacy name opens Google Maps (PR 821); asked which upgrade
--   to build first he chose "Free top-2,616 match": match the pharmacies carrying 80% of sales to their
--   exact Google listing inside Google's free monthly place-search allowance, so their link opens the
--   shop itself instead of a search. The matching rule is src/lib/sales/territory/pharmacy-place-match.ts;
--   the run is scripts/territory-match-pharmacy-places.ts, capped per month so the allowance Phoenix
--   CRM also uses is never passed.
-- ROLLBACK: drop function public.phx_territory_pharmacies_to_match(text[], numeric, integer);
--   drop table public.territory_pharmacy_place_matches;  (loses only the matches, which a re-run rebuilds)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration writes no rows and drops nothing.

begin;

create table if not exists public.territory_pharmacy_place_matches (
  distributor_code text not null,
  client_code text not null,
  status text not null check (status in ('matched', 'no_match', 'ambiguous', 'lookup_failed')),
  google_place_id text,
  search_text text not null,
  brick_id text,
  looked_up_at timestamptz not null default now(),
  primary key (distributor_code, client_code),
  check ((status = 'matched') = (google_place_id is not null))
);

comment on table public.territory_pharmacy_place_matches is
  'Territory Drilldown: the Google Maps place each top pharmacy was matched to (place id only), or why not. Written by scripts/territory-match-pharmacy-places.ts; read by the drilldown (pharmacy-directions-sources.ts).';

create index if not exists territory_pharmacy_place_matches_looked_up_at_idx
  on public.territory_pharmacy_place_matches (looked_up_at);

alter table public.territory_pharmacy_place_matches enable row level security;
revoke all on table public.territory_pharmacy_place_matches from public, anon, authenticated;
grant select, insert, update, delete on table public.territory_pharmacy_place_matches to service_role;

create or replace function public.phx_territory_pharmacies_to_match(
  p_periods text[],
  p_share numeric,
  p_limit integer
)
returns table (
  distributor_code text,
  client_code text,
  client_name text,
  brick_id text,
  brick_name text,
  brick_latitude double precision,
  brick_longitude double precision,
  sales_value numeric,
  sales_rank bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
#variable_conflict use_column
begin
  return query
  with base as (
    select
      btrim(r.client_code) as cc,
      upper(btrim(coalesce(r.distributor_code, ''))) as d,
      r.client_name,
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.product_code, r.period, r.total_qty, r.is_direct, r.direct_value,
      r.latest_row_created_at
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    where r.period = any (p_periods)
      and r.client_code is not null
      and btrim(coalesce(r.distributor_code, '')) <> ''
      and lower(btrim(coalesce(r.official_line, ''))) in ('cns', 'pedia', 'anti infective')
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  prices as (
    select distinct bs.product_code, bs.period, public.phx_factory_price(bs.product_code, bs.period) as price
    from base bs
  ),
  valued as (
    select bs.d, bs.cc,
      sum(case when bs.is_direct then coalesce(bs.direct_value, 0) else coalesce(bs.total_qty, 0) * coalesce(pr.price, 0) end) as v
    from base bs
    left join prices pr on pr.product_code = bs.product_code and pr.period = bs.period
    group by bs.d, bs.cc
  ),
  ranked as (
    select vl.d, vl.cc, vl.v,
      row_number() over (order by vl.v desc, vl.d, vl.cc) as rn,
      sum(vl.v) over (order by vl.v desc, vl.d, vl.cc) - vl.v as cum_before,
      sum(vl.v) over () as tot
    from valued vl
    where vl.v > 0
  ),
  latest as (
    select distinct on (bs.d, bs.cc) bs.d, bs.cc, bs.client_name, bs.brick_id
    from base bs
    order by bs.d, bs.cc, bs.latest_row_created_at desc nulls last
  )
  select rk.d, rk.cc, lt.client_name, lt.brick_id, bk.brick_name, g.latitude, g.longitude, rk.v, rk.rn
  from ranked rk
  join latest lt on lt.d = rk.d and lt.cc = rk.cc
  left join public.source_of_sales_bricks bk on bk.brick_id = lt.brick_id
  left join lateral (
    select gl.latitude, gl.longitude
    from public.geo_locations gl
    where gl.source_type = 'brick_centroid' and gl.source_key = lt.brick_id
    limit 1
  ) g on true
  where rk.cum_before < p_share * rk.tot
    and not exists (
      select 1 from public.territory_pharmacy_place_matches m
      where m.distributor_code = rk.d and m.client_code = rk.cc and m.status <> 'lookup_failed'
    )
  order by rk.rn
  limit greatest(coalesce(p_limit, 0), 0);
end;
$function$;

comment on function public.phx_territory_pharmacies_to_match(text[], numeric, integer) is
  'Territory Drilldown: pharmacies ranked by sales value down to a share of the total, not yet matched to a Google place — feeds scripts/territory-match-pharmacy-places.ts.';

revoke execute on function public.phx_territory_pharmacies_to_match(text[], numeric, integer) from public, anon, authenticated;
grant execute on function public.phx_territory_pharmacies_to_match(text[], numeric, integer) to service_role;

commit;

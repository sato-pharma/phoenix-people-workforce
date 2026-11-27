-- territory_area_pharmacy_locations
--
-- WHAT THIS CHANGES: adds one read-only function, phx_territory_area_pharmacy_locations. For the
--   pharmacies the Territory Drilldown lists in an area it returns each distributor row (latest name
--   and address), the brick's name and centre, and every point a rep confirmed at that shop: a
--   validated marketing pharmacy, an accepted direct-order venue (the live photo's GPS first) or an
--   active Phoenix CRM pharmacy place, each tied to the same (distributor, customer code). Nothing is
--   written and nothing is dropped; phx_territory_area_pharmacy_sources (20261127081222) stays as it is.
-- WHY: that first function needed about twenty follow-up reads per area from the app, which added
--   2-4 seconds to opening an area (measured on production, Cairo 1 CNS, 27 Nov 2026). One call is
--   one round trip, run beside the pharmacy figures. Which point or address is used stays in
--   src/lib/sales/territory/pharmacy-directions.ts, where it is tested. A new name rather than a
--   changed return type, because changing it would mean dropping the first function, and that drop
--   was declined at Supabase's confirmation on 27 Nov 2026.
-- ROLLBACK: drop function if exists public.phx_territory_area_pharmacy_locations(text[], text[], text[]);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_territory_area_pharmacy_locations(
  p_area_codes text[],
  p_periods text[],
  p_lines text[]
)
returns table (
  client_code text,
  distributor_code text,
  client_name text,
  client_address text,
  brick_id text,
  brick_name text,
  brick_latitude double precision,
  brick_longitude double precision,
  confirmed_points jsonb
)
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      btrim(r.client_code) as client_code,
      upper(btrim(coalesce(r.distributor_code, ''))) as distributor_code,
      r.client_name,
      r.client_address,
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.latest_row_created_at
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  src as (
    select distinct on (f.client_code, f.distributor_code)
      f.client_code, f.distributor_code, f.client_name, f.client_address, f.brick_id
    from filtered f
    order by f.client_code, f.distributor_code, f.latest_row_created_at desc nulls last
  ),
  codes as (
    select distinct s.client_code from src s
  ),
  points as (
    -- 1. A validated marketing pharmacy, through its matched distributor code.
    select upper(btrim(c.mapped_distributor_code)) as d, btrim(c.mapped_customer_code) as cc,
           p.captured_latitude as lat, p.captured_longitude as lon
    from public.marketing_pharmacy_distributor_codes c
    join public.marketing_pharmacies p on p.id = c.pharmacy_id
    where c.active
      and c.reference_status in ('matched', 'manual_approved')
      and p.active
      and p.merged_into_pharmacy_id is null
      and p.validation_status in ('system_validated', 'sfe_validated')
      and p.captured_latitude is not null and p.captured_longitude is not null
      and btrim(c.mapped_customer_code) in (select k.client_code from codes k)
    union all
    -- 2. A direct-order venue the validation desk accepted: the live photo's own GPS first.
    select upper(btrim(v.matched_distributor_code)), btrim(v.matched_customer_code),
           case when v.photo_latitude is not null and v.photo_longitude is not null then v.photo_latitude else v.captured_latitude end,
           case when v.photo_latitude is not null and v.photo_longitude is not null then v.photo_longitude else v.captured_longitude end
    from public.direct_order_pharmacy_validations v
    where v.status in ('matched_existing', 'approved_new')
      and btrim(v.matched_customer_code) in (select k.client_code from codes k)
    union all
    -- 3. A Phoenix CRM pharmacy linked to the distributor customer (one shop per name), and its place.
    select upper(btrim(l.distributor_code)), btrim(l.customer_code), pl.lat, pl.lon
    from public.phoenix_crm_pharmacy_distributor_links l
    join public.phoenix_crm_customers cu
      on cu.id = l.crm_customer_id and cu.list_type = 'Pharmacy' and not cu.is_test
    join public.phoenix_crm_places pl
      on pl.customer_id = cu.id and pl.status = 'active' and pl.retired_at is null and not pl.is_test
    where l.active
      and pl.lat is not null and pl.lon is not null
      and btrim(l.customer_code) in (select k.client_code from codes k)
  )
  select
    s.client_code,
    s.distributor_code,
    s.client_name,
    s.client_address,
    s.brick_id,
    bk.brick_name,
    g.latitude,
    g.longitude,
    coalesce(
      (select jsonb_agg(jsonb_build_array(pt.lat, pt.lon))
         from points pt
        where pt.d = s.distributor_code and pt.cc = s.client_code
          and pt.lat is not null and pt.lon is not null),
      '[]'::jsonb
    )
  from src s
  left join public.source_of_sales_bricks bk on bk.brick_id = s.brick_id
  left join lateral (
    select gl.latitude, gl.longitude
    from public.geo_locations gl
    where gl.source_type = 'brick_centroid' and gl.source_key = s.brick_id
    limit 1
  ) g on true;
end;
$function$;

comment on function public.phx_territory_area_pharmacy_locations(text[], text[], text[]) is
  'Territory Drilldown: each listed pharmacy''s distributor rows (latest name, address, brick name and centre) and the points reps confirmed at that shop — feeds the Google Maps directions link (pharmacy-directions.ts).';

revoke execute on function public.phx_territory_area_pharmacy_locations(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacy_locations(text[], text[], text[]) to service_role;

commit;

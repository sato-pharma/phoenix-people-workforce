-- territory_area_pharmacy_sources
--
-- WHAT THIS CHANGES: adds one read-only function, phx_territory_area_pharmacy_sources. For the
--   pharmacies the Territory Drilldown lists in an area, it returns each pharmacy's distributor rows
--   as (client code, distributor, latest name, latest address, brick), over exactly the same rows
--   phx_territory_area_pharmacies reads (validated batches, same area, months, line and excluded
--   products). Nothing is written and no existing function changes.
-- WHY: owner, 2026-11-27, asked for the pharmacy name in the drilldown to open Google Maps
--   directions, using the Ibn Sina family and POS addresses when no location was confirmed on site.
--   The existing function groups by client code alone and returns no distributor or address, so a
--   pharmacy's directions could not be traced back to the distributor row they come from.
-- ROLLBACK: drop function if exists public.phx_territory_area_pharmacy_sources(text[], text[], text[]);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_territory_area_pharmacy_sources(
  p_area_codes text[],
  p_periods text[],
  p_lines text[]
)
returns table (
  client_code text,
  distributor_code text,
  client_name text,
  client_address text,
  brick_id text
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
      r.client_code,
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
  )
  select distinct on (f.client_code, f.distributor_code)
    f.client_code,
    f.distributor_code,
    f.client_name,
    f.client_address,
    f.brick_id
  from filtered f
  order by f.client_code, f.distributor_code, f.latest_row_created_at desc nulls last;
end;
$function$;

comment on function public.phx_territory_area_pharmacy_sources(text[], text[], text[]) is
  'Territory Drilldown: each listed pharmacy''s distributor rows (latest name, address, brick) over the same rows as phx_territory_area_pharmacies — feeds the Google Maps directions link.';

revoke execute on function public.phx_territory_area_pharmacy_sources(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacy_sources(text[], text[], text[]) to service_role;

commit;

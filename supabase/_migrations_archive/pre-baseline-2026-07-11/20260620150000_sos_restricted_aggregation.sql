-- Adds a helper RPC for the SoS import dashboard to aggregate region/area/brick
-- breakdowns from raw import rows, excluding restricted product codes (LA003/LA004).
-- Called server-side only (service_role); anon/authenticated access revoked.
--
-- The pre-aggregated `source_of_sales_import_summaries` rows bake in ALL products'
-- value at write time, so they cannot be filtered post-hoc for restricted products.
-- This RPC re-aggregates directly from `source_of_sales_import_rows` for the
-- geographic dimensions, which is the only way to get correct per-region/area/brick
-- totals for non-CEO/SuperAdmin roles without a heavy schema migration.

create or replace function public.phx_sos_geo_aggregates_without_restricted(
  p_batch_ids    uuid[],
  p_exclude_codes text[] default '{LA003,LA004}'::text[]
)
returns table (
  group_type     text,
  group_key      text,
  group_label    text,
  group_code     text,
  official_line  text,
  row_count      bigint,
  total_qty      numeric,
  total_bonus_qty numeric,
  total_value    numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $$
  with excluded as materialized (
    select upper(btrim(c)) as code
    from unnest(coalesce(p_exclude_codes, '{}'::text[])) as c
    where btrim(c) <> ''
  ),
  base as materialized (
    select
      r.batch_id,
      r.region_code,
      r.region_name,
      r.area_code,
      r.area_name,
      r.brick_id,
      r.official_line,
      r.qty,
      r.bonus_qty,
      r.value
    from source_of_sales_import_rows r
    where r.batch_id = any(p_batch_ids)
      and r.validation_state = 'valid'
      and (
        not exists (select 1 from excluded)
        or upper(btrim(coalesce(r.product_code, ''))) not in (select code from excluded)
      )
  )
  -- ── Region ───────────────────────────────────────────────────────────────
  select
    'region'::text                                                           as group_type,
    coalesce(region_code, '') || '|' || coalesce(region_name, '')           as group_key,
    coalesce(region_name, region_code, '')                                   as group_label,
    region_code::text                                                        as group_code,
    null::text                                                               as official_line,
    count(*)::bigint                                                         as row_count,
    sum(qty)::numeric                                                        as total_qty,
    sum(bonus_qty)::numeric                                                  as total_bonus_qty,
    sum(value)::numeric                                                      as total_value
  from base
  group by region_code, region_name

  union all

  -- ── Area ─────────────────────────────────────────────────────────────────
  select
    'area'::text,
    coalesce(area_code, '') || '|' || coalesce(area_name, '') || '|' || coalesce(region_code, ''),
    coalesce(area_name, area_code, ''),
    area_code::text,
    coalesce(region_name, region_code)::text,
    count(*)::bigint,
    sum(qty)::numeric,
    sum(bonus_qty)::numeric,
    sum(value)::numeric
  from base
  group by area_code, area_name, region_code, region_name

  union all

  -- ── Brick ────────────────────────────────────────────────────────────────
  -- brick_name is NOT stored in import rows; the JS layer resolves it from
  -- source_of_sales_bricks after the fact (same as for CEO path).
  select
    'brick'::text,
    coalesce(brick_id, '') || '||' || coalesce(area_code, '') || '|' || coalesce(region_code, ''),
    coalesce(brick_id, ''),
    brick_id::text,
    coalesce(area_name, area_code)::text,
    count(*)::bigint,
    sum(qty)::numeric,
    sum(bonus_qty)::numeric,
    sum(value)::numeric
  from base
  group by brick_id, area_code, area_name, region_code
$$;

-- Postgres grants EXECUTE to PUBLIC by default on function creation; revoke from
-- PUBLIC (not just anon/authenticated, which inherit through it) to keep it server-only.
revoke all on function public.phx_sos_geo_aggregates_without_restricted(uuid[], text[]) from public;
grant execute on function public.phx_sos_geo_aggregates_without_restricted(uuid[], text[]) to service_role;

comment on function public.phx_sos_geo_aggregates_without_restricted is
  'Geographic (region/area/brick) aggregation from raw SoS import rows, excluding the given product codes. '
  'Used by the import dashboard for non-CEO/SuperAdmin roles so totals exclude confidential products (LA003/LA004).';

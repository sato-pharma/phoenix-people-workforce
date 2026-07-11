-- God-mode customer mapping, phase 4.
-- 1) Provenance columns on the customer map: how confident the mapper was and who/what mapped it
--    (source column already distinguishes manual / admin-import / normalizer / auto).
-- 2) A set-based backfill RPC that heals already-imported sales rows once a mapping exists:
--    ONLY rows whose brick_id is NULL are touched — an existing brick is never overwritten.

alter table public.source_of_sales_customer_map
  add column if not exists confidence smallint null,
  add column if not exists mapped_by text null;

comment on column public.source_of_sales_customer_map.confidence is
  'Geo-validated confidence (0-100) captured when the mapping was saved via auto-apply; null for manual mappings.';
comment on column public.source_of_sales_customer_map.mapped_by is
  'Login id of the operator whose action created/updated the mapping (auto-apply records the clicking admin).';

create or replace function public.sos_backfill_import_rows_from_customer_map(
  p_distributor text,
  p_customer text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  update public.source_of_sales_import_rows r
  set brick_id = m.brick_id,
      area_code = b.area_code,
      area_name = coalesce(a.area_name, r.area_name),
      region_code = b.region_code,
      region_name = coalesce(g.region_name, r.region_name)
  from public.source_of_sales_customer_map m
  join public.source_of_sales_bricks b on b.brick_id = m.brick_id
  left join public.source_of_sales_areas a on a.area_code = b.area_code
  left join public.source_of_sales_regions g on g.region_code = b.region_code
  where m.distributor_code = p_distributor
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
    and r.distributor_code = p_distributor
    and r.client_code = p_customer
    and r.brick_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.sos_backfill_import_rows_from_customer_map(text, text) is
  'Fills brick/area/region on historical import rows (brick_id IS NULL only) from an active customer mapping. Returns updated row count.';

revoke all on function public.sos_backfill_import_rows_from_customer_map(text, text) from public;
revoke all on function public.sos_backfill_import_rows_from_customer_map(text, text) from anon;
revoke all on function public.sos_backfill_import_rows_from_customer_map(text, text) from authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text) to service_role;

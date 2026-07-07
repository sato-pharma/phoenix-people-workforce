-- God-mode customer mapping, phase 5: historical reconciliation (overwrite mismatches, not just NULLs).
--
-- sos_backfill_import_rows_from_customer_map (phase 4, 20260703090000) only heals rows where
-- brick_id IS NULL — an existing (possibly WRONG) brick_id is never touched there, by design, since
-- that RPC fires automatically on every routine single-customer-mapping save. This migration adds a
-- SEPARATE, explicit "reconcile" path for when a customer's mapping was just corrected from a live
-- sheet upload (the app-side self-heal in src/lib/sales/normalizer/customer-map.ts) and an admin
-- explicitly wants historical rows for that customer brought in line with the new, sheet-verified
-- brick too. Never wired to run automatically — always a deliberate, per-customer, admin-triggered
-- action from the app.
--
-- Two RPCs:
--  1. sos_count_reconcilable_import_rows — READ-ONLY preview: how many historical rows disagree with
--     the customer's current active mapping, which bricks they're currently coded to (with counts),
--     and which batches they're in. No side effects — safe to call any time, no permission risk beyond
--     read access.
--  2. sos_reconcile_import_rows_from_customer_map — the actual UPDATE. Overwrites brick_id/area/region
--     on every row for (distributor, customer) that disagrees with the active mapping (not just NULL
--     ones). Returns the updated row count AND the distinct batch_ids touched, so the caller can refresh
--     exactly those batches' rollups (fact rollup, customer directory rollup, marketing ROI facts) —
--     never left stale.

create or replace function public.sos_count_reconcilable_import_rows(
  p_distributor text,
  p_customer text
) returns table (
  affected_rows integer,
  affected_batch_ids uuid[],
  current_bricks jsonb,
  target_brick_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_brick text;
  v_rows integer;
  v_batches uuid[];
  v_current jsonb;
begin
  select m.brick_id into v_target_brick
  from public.source_of_sales_customer_map m
  where m.distributor_code = p_distributor
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
  limit 1;

  if v_target_brick is null then
    return query select 0, '{}'::uuid[], '{}'::jsonb, null::text;
    return;
  end if;

  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from public.source_of_sales_import_rows
  where distributor_code = p_distributor
    and client_code = p_customer
    and brick_id is distinct from v_target_brick;

  select coalesce(jsonb_object_agg(brick_id, cnt), '{}'::jsonb) into v_current
  from (
    select coalesce(nullif(brick_id, ''), '(none)') as brick_id, count(*) as cnt
    from public.source_of_sales_import_rows
    where distributor_code = p_distributor
      and client_code = p_customer
      and brick_id is distinct from v_target_brick
    group by 1
  ) g;

  return query select v_rows, v_batches, v_current, v_target_brick;
end;
$$;

comment on function public.sos_count_reconcilable_import_rows(text, text) is
  'Read-only dry-run: counts historical import rows that disagree with the active customer->brick mapping, grouped by their current brick, plus the distinct batch_ids affected. No side effects.';

revoke all on function public.sos_count_reconcilable_import_rows(text, text) from public;
revoke all on function public.sos_count_reconcilable_import_rows(text, text) from anon;
revoke all on function public.sos_count_reconcilable_import_rows(text, text) from authenticated;
grant execute on function public.sos_count_reconcilable_import_rows(text, text) to service_role;

create or replace function public.sos_reconcile_import_rows_from_customer_map(
  p_distributor text,
  p_customer text
) returns table (
  updated_rows integer,
  affected_batch_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
begin
  with target as (
    select m.brick_id, b.area_code, b.region_code, a.area_name, g.region_name
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.distributor_code = p_distributor
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
    limit 1
  ),
  updated as (
    update public.source_of_sales_import_rows r
    set brick_id = t.brick_id,
        area_code = t.area_code,
        area_name = coalesce(t.area_name, r.area_name),
        region_code = t.region_code,
        region_name = coalesce(t.region_name, r.region_name)
    from target t
    where r.distributor_code = p_distributor
      and r.client_code = p_customer
      and r.brick_id is distinct from t.brick_id
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$$;

comment on function public.sos_reconcile_import_rows_from_customer_map(text, text) is
  'Overwrites brick/area/region on EVERY historical import row for (distributor, customer) that disagrees with the active customer->brick mapping (not just NULL ones, unlike sos_backfill_import_rows_from_customer_map). Returns the updated row count and the distinct batch_ids touched so the caller can refresh their rollups. Always explicit/admin-triggered — never called automatically from a routine upload.';

revoke all on function public.sos_reconcile_import_rows_from_customer_map(text, text) from public;
revoke all on function public.sos_reconcile_import_rows_from_customer_map(text, text) from anon;
revoke all on function public.sos_reconcile_import_rows_from_customer_map(text, text) from authenticated;
grant execute on function public.sos_reconcile_import_rows_from_customer_map(text, text) to service_role;

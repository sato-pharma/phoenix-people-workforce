-- The history heal, the history correction and the correction's preview judge each sales FILE once,
-- not once per sales ROW.
--
-- WHAT WENT WRONG. 20260918143000 found the files to leave whole with one query:
--
--   select array_agg(f.batch_id)
--   from (select distinct r.batch_id from source_of_sales_import_rows r where <this customer's rows>) f
--   where public.sos_import_batch_touches_locked_closing(f.batch_id);
--
-- Postgres may push a filter on a DISTINCT column down into the subquery, and it did: the judgement
-- ran as a filter on the row scan, once per ROW. Each judgement reads its whole file (about 60 ms for
-- a Pharma Services file), so the cost grew with the customer's rows instead of their files.
--
--   * measured on production 2026-09-18: Pharma Services pharmacy 0001545315 (152 rows in 8 files)
--     took 9.3 s to judge, 152 judgements where 8 were needed;
--   * the app calls these functions through the database API, whose calls are cancelled after 8 s
--     (the authenticator role's statement_timeout; these functions set no limit of their own). So a
--     heal, correction or preview for a pharmacy with that many rows to change would be cancelled
--     and change nothing;
--   * no call was cancelled before this fix: the database log holds no statement timeout since
--     20260918143000 was applied (15:26 Cairo).
--
-- THE FIX. Each function first collects the files it would touch into a list, then judges that list,
-- one judgement per file. The two steps are separate statements, so no plan can merge them again.
--
-- Nothing else changes: the same files are left whole, the heal still fills only a missing brick, the
-- correction still re-stamps on brick OR area OR region, the preview counts exactly what the
-- correction will change, and the return shapes and service_role-only grants stay.

create or replace function public.sos_backfill_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
  v_files uuid[] := '{}';
  v_frozen uuid[] := '{}';
begin
  -- Files this heal would touch that hold a locked row. They stay whole (see 20260918143000).
  -- Collected first, then judged once per file (see the header).
  select coalesce(array_agg(distinct r.batch_id), '{}')
    into v_files
  from public.source_of_sales_import_rows r
  where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
    and r.client_code = p_customer
    and (r.brick_id is null or r.brick_id = '');

  select coalesce(array_agg(f.batch_id), '{}')
    into v_frozen
  from unnest(v_files) as f(batch_id)
  where public.sos_import_batch_touches_locked_closing(f.batch_id);

  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id    = m.brick_id,
        area_code   = b.area_code,
        area_name   = coalesce(a.area_name, r.area_name),
        region_code = b.region_code,
        region_name = coalesce(g.region_name, r.region_name)
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
      and upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      -- Fills a MISSING brick only ('' is the normalizer's "unresolved" sentinel); re-pointing an
      -- existing one is sos_reconcile_import_rows_from_customer_map's job.
      and (r.brick_id is null or r.brick_id = '')
      -- A file that touches a locked month is never changed, so its totals never need a rebuild.
      and not (r.batch_id = any (v_frozen))
    returning r.batch_id
  )
  select count(*)::integer, coalesce(array_agg(distinct batch_id), '{}')
  into v_count, v_batches
  from updated;

  updated_rows := v_count;
  affected_batch_ids := v_batches;
  return next;
end;
$function$;

create or replace function public.sos_reconcile_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer := 0;
  v_batches uuid[] := '{}'::uuid[];
  v_files uuid[] := '{}'::uuid[];
  v_frozen uuid[] := '{}'::uuid[];
  v_brick text;
  v_area text;
  v_region text;
  v_area_name text;
  v_region_name text;
begin
  select m.brick_id, b.area_code, b.region_code, a.area_name, g.region_name
    into v_brick, v_area, v_region, v_area_name, v_region_name
  from public.source_of_sales_customer_map m
  join public.source_of_sales_bricks b on b.brick_id = m.brick_id
  left join public.source_of_sales_areas a on a.area_code = b.area_code
  left join public.source_of_sales_regions g on g.region_code = b.region_code
  where m.distributor_code = p_distributor
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
  limit 1;

  if v_brick is null then
    return query select 0, '{}'::uuid[];
    return;
  end if;

  -- Files this correction would touch that hold a locked row. They stay whole (see 20260918143000).
  -- Collected first, then judged once per file (see the header).
  select coalesce(array_agg(distinct r.batch_id), '{}'::uuid[])
    into v_files
  from public.source_of_sales_import_rows r
  where r.distributor_code = p_distributor
    and r.client_code = p_customer
    and (   r.brick_id    is distinct from v_brick
         or r.area_code   is distinct from v_area
         or r.region_code is distinct from v_region );

  select coalesce(array_agg(f.batch_id), '{}'::uuid[])
    into v_frozen
  from unnest(v_files) as f(batch_id)
  where public.sos_import_batch_touches_locked_closing(f.batch_id);

  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id = v_brick,
        area_code = v_area,
        area_name = coalesce(v_area_name, r.area_name),
        region_code = v_region,
        region_name = coalesce(v_region_name, r.region_name)
    where r.distributor_code = p_distributor
      and r.client_code = p_customer
      and (   r.brick_id    is distinct from v_brick
           or r.area_code   is distinct from v_area
           or r.region_code is distinct from v_region )
      -- A file that touches a locked month is never changed, so its totals never need a rebuild.
      and not (r.batch_id = any (v_frozen))
    returning r.batch_id
  )
  select count(*), coalesce(array_agg(distinct batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from updated;

  return query select v_rows, v_batches;
end;
$function$;

create or replace function public.sos_count_reconcilable_import_rows(p_distributor text, p_customer text)
returns table(affected_rows integer, affected_batch_ids uuid[], current_bricks jsonb, target_brick_id text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target_brick text;
  v_rows integer;
  v_batches uuid[];
  v_current jsonb;
  v_files uuid[] := '{}'::uuid[];
  v_frozen uuid[] := '{}'::uuid[];
begin
  select m.brick_id into v_target_brick
  from public.source_of_sales_customer_map m
  where upper(btrim(m.distributor_code)) = upper(btrim(p_distributor))
    and m.customer_code = p_customer
    and m.active
    and m.brick_id is not null
  limit 1;

  if v_target_brick is null then
    return query select 0, '{}'::uuid[], '{}'::jsonb, null::text;
    return;
  end if;

  -- Files that touch a locked month are left out of the preview because the correction leaves them out.
  -- Collected first, then judged once per file (see the header).
  select coalesce(array_agg(distinct r.batch_id), '{}'::uuid[])
    into v_files
  from public.source_of_sales_import_rows r
  where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
    and r.client_code = p_customer
    and r.brick_id is distinct from v_target_brick;

  select coalesce(array_agg(f.batch_id), '{}'::uuid[])
    into v_frozen
  from unnest(v_files) as f(batch_id)
  where public.sos_import_batch_touches_locked_closing(f.batch_id);

  select count(*), coalesce(array_agg(distinct r.batch_id), '{}'::uuid[])
    into v_rows, v_batches
  from public.source_of_sales_import_rows r
  where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
    and r.client_code = p_customer
    and r.brick_id is distinct from v_target_brick
    and not (r.batch_id = any (v_frozen));

  select coalesce(jsonb_object_agg(brick_id, cnt), '{}'::jsonb) into v_current
  from (
    select coalesce(nullif(r.brick_id, ''), '(none)') as brick_id, count(*) as cnt
    from public.source_of_sales_import_rows r
    where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      and r.brick_id is distinct from v_target_brick
      and not (r.batch_id = any (v_frozen))
    group by 1
  ) g;

  return query select v_rows, v_batches, v_current, v_target_brick;
end;
$function$;

revoke execute on function public.sos_import_batch_touches_locked_closing(uuid)
  from public, anon, authenticated;
grant execute on function public.sos_import_batch_touches_locked_closing(uuid)
  to service_role;

revoke execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  to service_role;

revoke execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  to service_role;

revoke execute on function public.sos_count_reconcilable_import_rows(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_count_reconcilable_import_rows(text, text)
  to service_role;

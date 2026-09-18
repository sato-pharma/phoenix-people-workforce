-- The history heal and the history correction step around a whole sales FILE that touches a locked
-- month, not just around the locked rows inside it.
--
-- WHAT WENT WRONG. 20260918140000 taught both functions to skip a row whose own (invoice_period,
-- official_line) is locked. That is enough for the import-row lock trigger, but not for the rebuild
-- that must follow: every phx_refresh_sos_* rebuilds a file's totals by deleting and re-inserting ALL
-- of that file's rollup rows, and the rollup tables carry the same statement-level lock trigger. A
-- distributor's July or August file mixes Head Office rows (never locked - Head Office is not in the
-- closing) with CNS, Pedia and Anti Infective rows (locked). So the heal could fill a Head Office row
-- in a locked file and then never rebuild that file:
--
--   * measured on production 2026-09-18: 4 July files and 3 August files mix the two (20,829 and
--     19,855 Head Office rows); 42 of those Head Office rows have no brick (31 pharmacies), and 4 of
--     them already have a live mapping, so the next mapping save for those pharmacies would fill them;
--   * a rolled-back probe of the live heal filled 1 such row, and a rolled-back rebuild of a mixed July
--     file failed with "Monthly closing CNS 2026-07 is LOCKED";
--   * backfillCustomerRows (src/lib/sales/normalizer/mapping.ts) swallows refresh errors by design,
--     so the fill would have stayed with totals that disagree with it, silently. The history
--     correction would have failed loudly after committing its re-stamp.
--
-- No damage was done before this fix: all 23,130 Head Office groups in those files still match their
-- totals exactly.
--
-- THE FIX. sos_import_batch_touches_locked_closing says whether any row of a file sits in an open lock,
-- judged on the row's own month AND on the file's month (the fact rollup files a row under the file's
-- month). Each function now leaves such a file whole: none of its rows change, so its totals never
-- need a rebuild that the lock would refuse. A file with no locked row cannot hit the lock anywhere,
-- so the row-level check is no longer needed. Only files that hold a row the function would change are
-- judged, so a customer with nothing to heal pays nothing for the check.
--
-- Nothing else changes: the heal still fills only a missing brick; the reconcile still re-stamps on
-- brick OR area OR region; the preview counts exactly what the correction will change; return shapes
-- and the service_role-only grants stay.

begin;

create or replace function public.sos_import_batch_touches_locked_closing(p_batch_id uuid)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    join public.monthly_closing_locks l
      on l.unlocked_at is null
     and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
     and l.period in (r.invoice_period, b.period)
    where r.batch_id = p_batch_id
  );
$function$;

comment on function public.sos_import_batch_touches_locked_closing(uuid) is
  'True when any row of this sales file sits in an open monthly-closing lock (on its own month or the file''s). Such a file is left whole by every history heal and correction: its totals cannot be rebuilt while the lock stands.';

create or replace function public.sos_backfill_import_rows_from_customer_map(p_distributor text, p_customer text)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
  v_frozen uuid[] := '{}';
begin
  -- Files this heal would touch that hold a locked row. They stay whole (see the header).
  select coalesce(array_agg(f.batch_id), '{}')
    into v_frozen
  from (
    select distinct r.batch_id
    from public.source_of_sales_import_rows r
    where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      and (r.brick_id is null or r.brick_id = '')
  ) f
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

  -- Files this correction would touch that hold a locked row. They stay whole (see the header).
  select coalesce(array_agg(f.batch_id), '{}'::uuid[])
    into v_frozen
  from (
    select distinct r.batch_id
    from public.source_of_sales_import_rows r
    where r.distributor_code = p_distributor
      and r.client_code = p_customer
      and (   r.brick_id    is distinct from v_brick
           or r.area_code   is distinct from v_area
           or r.region_code is distinct from v_region )
  ) f
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
  select coalesce(array_agg(f.batch_id), '{}'::uuid[])
    into v_frozen
  from (
    select distinct r.batch_id
    from public.source_of_sales_import_rows r
    where upper(btrim(r.distributor_code)) = upper(btrim(p_distributor))
      and r.client_code = p_customer
      and r.brick_id is distinct from v_target_brick
  ) f
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

commit;

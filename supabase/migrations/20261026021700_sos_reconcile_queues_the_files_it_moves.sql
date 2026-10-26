-- The history correction queues the sales files it re-points IN THE SAME TRANSACTION (audit P4-06).
--
-- WHAT WAS LEFT OPEN. sos_reconcile_import_rows_from_customer_map re-points a pharmacy's earlier
-- sales rows onto the brick its mapping now holds, and the files it changed must then be rebuilt:
-- their rollups, split net and attribution still credit the brick the rows left. The rebuild runs
-- from the brick-move queue (source_of_sales_brick_move_files, emptied every 20 minutes by
-- phoenix-brick-move-drain). But the queue was written by the APP, in a second call after this
-- function had already committed. Since 2026-10-23 that write follows each correction at once
-- (healAddressCorrectionHistory), which narrowed the gap to one correction; it did not close it. A
-- deploy, a dropped connection or a timeout between the two calls left rows already moved and their
-- files never queued: the totals kept crediting the old brick, nothing would ever rebuild them, and
-- nothing alarmed. The other two callers (applyHistoricalReconciliation, which rebuilds inline, and
-- scripts/reconcile-month-customer-map.ts) never queued at all, so a rebuild that failed there was
-- lost the same way.
--
-- THE FIX. The function now writes the queue row for every file it changed in the same statement as
-- the change itself, so the two commit together or not at all: there is no moment at which a row has
-- moved and its file is not waiting for a rebuild.
--
-- EACH FILE ONCE, AND SAFE TO REPEAT.
--   * one queue row per file, not per row, keyed exactly as the brick move keys it: the brick the
--     file's rows left (the one most of them left, when the brick master holds it), else the brick
--     they joined, which always exists;
--   * a file already waiting in the queue under any brick keeps that row, re-stamped, instead of
--     getting a second one;
--   * the write is an upsert on the queue's own key, as sos_move_brick_sales writes it: a repeat
--     re-stamps moved_at and clears refreshed_at, so a rebuild already running when more rows moved
--     is not counted as covering them (sos_finish_brick_move_file compares moved_at) and the drain
--     rebuilds the file again. A claim in progress is left alone, so two rebuilds never run at once;
--   * a call that changes nothing queues nothing.
--
-- Nothing else changes: the same rows are re-pointed to the same brick, area and region, a file that
-- touches a locked month is still left whole and judged once per file (20260918143100), the
-- signature, the return shape, SECURITY DEFINER, the pinned search_path and the service_role-only
-- grant stay as they were. The app's own queue write after the call stays too: it is the same
-- idempotent upsert, and it still covers the files while this migration waits to be applied.

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
  -- Collected first, then judged once per file (see 20260918143100).
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
    -- The same row as the statement found it, so the brick each row LEFT can be returned.
    from public.source_of_sales_import_rows pre
    where pre.id = r.id
      and r.distributor_code = p_distributor
      and r.client_code = p_customer
      and (   r.brick_id    is distinct from v_brick
           or r.area_code   is distinct from v_area
           or r.region_code is distinct from v_region )
      -- A file that touches a locked month is never changed, so its totals never need a rebuild.
      and not (r.batch_id = any (v_frozen))
    returning r.batch_id, pre.brick_id as left_brick_id
  ),
  per_file as (
    select u.batch_id, count(*)::integer as moved_rows
    from updated u
    group by u.batch_id
  ),
  -- The brick most of a file's moved rows left, when the brick master holds it (the queue's key
  -- references the master; an empty or unknown brick cannot key a row).
  left_brick as (
    select distinct on (u.batch_id) u.batch_id, u.left_brick_id
    from updated u
    join public.source_of_sales_bricks b on b.brick_id = u.left_brick_id
    group by u.batch_id, u.left_brick_id
    order by u.batch_id, count(*) desc, u.left_brick_id
  ),
  -- A file already waiting for a rebuild keeps its row: re-stamped below, never queued twice.
  waiting as (
    select distinct on (q.batch_id) q.batch_id, q.old_brick_id
    from public.source_of_sales_brick_move_files q
    join per_file pf on pf.batch_id = q.batch_id
    where q.refreshed_at is null
    order by q.batch_id, q.moved_at desc, q.old_brick_id
  ),
  -- One key per file: the waiting row's, else the brick the rows left, else the brick they joined.
  keyed as (
    select coalesce(w.old_brick_id, lb.left_brick_id, v_brick) as old_brick_id, pf.batch_id, pf.moved_rows
    from per_file pf
    left join waiting w on w.batch_id = pf.batch_id
    left join left_brick lb on lb.batch_id = pf.batch_id
  ),
  -- Runs to completion with the update above, as one statement: a moved row's file is always queued.
  queued as (
    insert into public.source_of_sales_brick_move_files as f (old_brick_id, batch_id, moved_rows)
    select k.old_brick_id, k.batch_id, k.moved_rows
    from keyed k
    on conflict (old_brick_id, batch_id) do update
      set moved_rows   = f.moved_rows + excluded.moved_rows,
          moved_at     = now(),
          refreshed_at = null
    returning f.batch_id
  )
  select coalesce((select sum(pf.moved_rows) from per_file pf), 0)::integer,
         coalesce((select array_agg(q.batch_id order by q.batch_id) from queued q), '{}'::uuid[])
    into v_rows, v_batches;

  return query select v_rows, v_batches;
end;
$function$;

revoke execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_reconcile_import_rows_from_customer_map(text, text)
  to service_role;

-- A brick move judges each sales file once, not once per sales row.
--
-- 20260918150000 found the files a move must leave whole with one query: a filter on a subquery over
-- the brick's rows. Postgres pushed that filter down into the row scan and ran the judgement once per
-- ROW (the same fault 20260918143100 fixes in the history heal and correction). Each judgement reads
-- its whole file:
--   * measured on production 2026-09-18 for أبو النمرس (B45-26, 435 rows in 42 files, 11 of them
--     locked): 20.0 s, 435 judgements where 42 were needed. Judged once per file: 1.0 s;
--   * a brick with a few thousand rows would pass the function's own 120-second limit, and its whole
--     move would be cancelled.
-- The files are now collected first, then each is judged once, in a separate statement so that no
-- plan can merge the two again. Nothing else changes.

create or replace function public.sos_move_brick_sales(p_old_brick text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_old         public.source_of_sales_bricks;
  v_new         public.source_of_sales_bricks;
  v_hops        integer := 0;
  v_area_name   text;
  v_region_name text;
  v_batches     uuid[];
  v_frozen      uuid[];
  v_moved       integer := 0;
  v_files       integer := 0;
  v_published   integer := 0;
  v_waiting     integer := 0;
  v_pending     integer := 0;
begin
  select * into v_old from public.source_of_sales_bricks b where b.brick_id = btrim(p_old_brick);
  if not found then
    raise exception 'That brick is no longer in the brick master.';
  end if;
  if v_old.superseded_by_brick_id is null then
    raise exception '% has not been moved, so it has no sales to carry.', v_old.brick_name;
  end if;

  -- A brick moved twice carries its sales to where it is today, not to the stop in between.
  select * into v_new from public.source_of_sales_bricks b where b.brick_id = v_old.superseded_by_brick_id;
  while found and v_new.superseded_by_brick_id is not null loop
    v_hops := v_hops + 1;
    if v_hops > 50 then
      raise exception 'The move history of % does not end. Nothing was moved.', v_old.brick_name;
    end if;
    select * into v_new from public.source_of_sales_bricks b where b.brick_id = v_new.superseded_by_brick_id;
  end loop;
  if v_new.brick_id is null then
    raise exception 'The brick % moved to is no longer in the brick master. Nothing was moved.', v_old.brick_name;
  end if;
  if v_new.active is false then
    raise exception '% is switched off, so the sales of % cannot move onto it.', v_new.brick_name, v_old.brick_name;
  end if;

  select a.area_name into v_area_name from public.source_of_sales_areas a where a.area_code = v_new.area_code;
  select g.region_name into v_region_name from public.source_of_sales_regions g where g.region_code = v_new.region_code;

  -- A file touching a locked month is left whole: its published rows cannot change, and its totals
  -- could never be rebuilt if any other row in it moved (the rule of 20260918143000).
  -- The files are collected first and each is judged once (see the header).
  select coalesce(array_agg(distinct r.batch_id), '{}'::uuid[]) into v_batches
  from public.source_of_sales_import_rows r
  where r.brick_id = v_old.brick_id;

  select coalesce(array_agg(f.batch_id), '{}'::uuid[]) into v_frozen
  from unnest(v_batches) as f(batch_id)
  where public.sos_import_batch_touches_locked_closing(f.batch_id);

  -- A row follows the brick unless its pharmacy's live mapping points somewhere else: still on the
  -- old brick (held on the Mapping guard, or kept there by the owner's rejection) or on another
  -- brick altogether (which the history correction answers for, not a move).
  with moved as (
    update public.source_of_sales_import_rows r
    set brick_id    = v_new.brick_id,
        block_code  = case when nullif(btrim(r.block_code), '') is null then r.block_code else v_new.block_code end,
        area_code   = v_new.area_code,
        area_name   = coalesce(v_area_name, r.area_name),
        region_code = v_new.region_code,
        region_name = coalesce(v_region_name, r.region_name)
    where r.brick_id = v_old.brick_id
      and r.batch_id <> all (v_frozen)
      and not exists (
        select 1
        from public.source_of_sales_customer_map m
        where m.active
          and m.distributor_code = r.distributor_code
          and m.customer_code = r.client_code
          and m.brick_id is distinct from v_new.brick_id
      )
    returning r.batch_id
  ),
  per_file as (
    select mv.batch_id, count(*)::integer as n
    from moved mv
    group by mv.batch_id
  ),
  saved as (
    insert into public.source_of_sales_brick_move_files as f (old_brick_id, batch_id, moved_rows)
    select v_old.brick_id, pf.batch_id, pf.n
    from per_file pf
    on conflict (old_brick_id, batch_id) do update
      set moved_rows   = f.moved_rows + excluded.moved_rows,
          moved_at     = now(),
          refreshed_at = null
    returning 1
  )
  select coalesce((select sum(pf.n) from per_file pf), 0)::integer,
         (select count(*) from saved)::integer
    into v_moved, v_files;

  select count(*)::integer into v_published
  from public.source_of_sales_import_rows r
  where r.brick_id = v_old.brick_id
    and r.batch_id = any (v_frozen);

  select count(*)::integer into v_waiting
  from public.source_of_sales_import_rows r
  join (
    select distinct h.before_json->>'distributor_code' as distributor_code,
                    h.before_json->>'customer_code'    as customer_code
    from public.sos_map_change_holds h
    where h.status = 'pending'
      and h.table_name = 'source_of_sales_customer_map'
      and h.before_json->>'brick_id' = v_old.brick_id
  ) w on w.distributor_code = r.distributor_code and w.customer_code = r.client_code
  where r.brick_id = v_old.brick_id
    and r.batch_id <> all (v_frozen);

  select count(*)::integer into v_pending
  from public.source_of_sales_brick_move_files f
  where f.old_brick_id = v_old.brick_id
    and f.refreshed_at is null;

  return jsonb_build_object(
    'toBrickId',     v_new.brick_id,
    'movedRows',     v_moved,
    'movedFiles',    v_files,
    'publishedRows', v_published,
    'waitingRows',   v_waiting,
    'pendingFiles',  v_pending
  );
end;
$function$;

revoke all on function public.sos_move_brick_sales(text) from public, anon, authenticated;
grant execute on function public.sos_move_brick_sales(text) to service_role;

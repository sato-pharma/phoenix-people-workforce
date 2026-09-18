-- Moving a brick to its right area ("Correct in database") carries its pharmacies and its sales.
--
-- The old move (relocateBrick in import-service.ts) made a new brick in the target block, SWITCHED
-- THE OLD ONE OFF and repointed the customer map from the app, one request at a time. Three faults:
--   1. A switched-off brick drops out of the Phoenix master, so every published-month sales row
--      still on it would flag "brick not in Phoenix master".
--   2. The sales rows never moved, so every unlocked month kept crediting the wrong area.
--   3. The customer-map update ran through the mapping guard, which silently drops a held move, and
--      the app counted only what it got back.
--
-- Now one transaction does the whole move:
--   * a new brick in the target block (the id follows the block, as the owner prefers);
--   * the old brick STAYS ACTIVE in its old area as history: renamed "<name> - <old area>", dated,
--     and pointing at its successor through superseded_by_brick_id, so published months still resolve;
--   * the customer map, the territory aliases, the direct-order pharmacies and their codes, and the
--     AI answers are repointed. A pharmacy carrying a decision of the owner's, or one the move would
--     take across a region, is held by the mapping guard as before (owner decision 2026-09-18,
--     "Wait on Mapping guard"): it stays on the old brick until he approves it;
--   * the sales rows of every pharmacy that moved follow it, in every file that touches no locked
--     month (the whole-file rule of 20260918143000). A published month is never changed.
-- Each file whose rows moved is recorded in source_of_sales_brick_move_files, and the app rebuilds its
-- totals one file at a time (claim, rebuild, finish), because a rebuild per file is too slow for one
-- request and two rebuilds of one file at once would count it twice.
--
-- Approving a held pharmacy on the Mapping guard moves the map row only; the app then calls
-- sos_move_brick_sales_after_hold, which moves that pharmacy's unlocked-month sales too.

-- ── The history marker ─────────────────────────────────────────────────────────────────────────
alter table public.source_of_sales_bricks
  add column if not exists superseded_by_brick_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.source_of_sales_bricks'::regclass
      and conname = 'source_of_sales_bricks_superseded_by_fk'
  ) then
    alter table public.source_of_sales_bricks
      add constraint source_of_sales_bricks_superseded_by_fk
      foreign key (superseded_by_brick_id) references public.source_of_sales_bricks (brick_id)
      on update cascade on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.source_of_sales_bricks'::regclass
      and conname = 'source_of_sales_bricks_superseded_by_not_self'
  ) then
    alter table public.source_of_sales_bricks
      add constraint source_of_sales_bricks_superseded_by_not_self
      check (superseded_by_brick_id is distinct from brick_id);
  end if;
end;
$$;

comment on column public.source_of_sales_bricks.superseded_by_brick_id is
  'The brick this one was moved to. Set only by sos_relocate_brick, never backfilled. A superseded '
  'brick stays active so published months keep resolving; it keeps only the sales that could not '
  'move (files touching a locked month, and pharmacies waiting on the Mapping guard).';

-- ── Files whose totals a move left to rebuild ──────────────────────────────────────────────────
create table if not exists public.source_of_sales_brick_move_files (
  old_brick_id       text        not null
    references public.source_of_sales_bricks (brick_id) on update cascade on delete cascade,
  batch_id           uuid        not null
    references public.source_of_sales_import_batches (id) on delete cascade,
  moved_rows         integer     not null default 0 check (moved_rows >= 0),
  moved_at           timestamptz not null default now(),
  refresh_started_at timestamptz,
  refreshed_at       timestamptz,
  primary key (old_brick_id, batch_id)
);

comment on table public.source_of_sales_brick_move_files is
  'One row per sales file whose rows a brick move re-stamped. refreshed_at is null until the app has '
  'rebuilt that file''s totals; a later move into the same file clears it again. refresh_started_at '
  'is a five-minute claim so two tabs never rebuild one file at once.';

alter table public.source_of_sales_brick_move_files enable row level security;
revoke all on table public.source_of_sales_brick_move_files from anon, authenticated;
grant select, insert, update, delete on table public.source_of_sales_brick_move_files to service_role;

-- ── Move the sales that follow a moved brick ───────────────────────────────────────────────────
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
  select coalesce(array_agg(x.batch_id), '{}'::uuid[]) into v_frozen
  from (
    select distinct r.batch_id
    from public.source_of_sales_import_rows r
    where r.brick_id = v_old.brick_id
  ) x
  where public.sos_import_batch_touches_locked_closing(x.batch_id);

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

-- ── The move itself ────────────────────────────────────────────────────────────────────────────
create or replace function public.sos_relocate_brick(
  p_brick_id                   text,
  p_block_code                 text,
  p_brick_name                 text,
  p_normalized_brick_name      text,
  p_historical_name            text,
  p_normalized_historical_name text,
  p_actor                      text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_today           date := (now() at time zone 'Africa/Cairo')::date;
  v_old             public.source_of_sales_bricks;
  v_block           public.source_of_sales_blocks;
  v_block_label     text;
  v_from_area       text;
  v_to_area         text;
  v_pending         integer;
  v_prefix          text;
  v_seq             bigint;
  v_new             text;
  v_tries           integer := 0;
  v_until           date;
  v_customers_moved integer;
  v_switched_off    integer;
  v_customers_held  integer;
  v_aliases         integer;
  v_pharmacies      integer;
  v_codes           integer;
  v_answers         integer;
  v_sales           jsonb;
begin
  -- The mapping guard records who asked for every change it logs or holds.
  if nullif(btrim(coalesce(p_actor, '')), '') is not null then
    perform set_config('phoenix.actor', btrim(p_actor), true);
  end if;

  if nullif(btrim(coalesce(p_brick_name, '')), '') is null
     or nullif(btrim(coalesce(p_normalized_brick_name, '')), '') is null then
    raise exception 'The moved brick needs a name.';
  end if;
  if nullif(btrim(coalesce(p_historical_name, '')), '') is null
     or nullif(btrim(coalesce(p_normalized_historical_name, '')), '') is null then
    raise exception 'The old brick needs a name to keep as its history.';
  end if;
  if p_normalized_brick_name = p_normalized_historical_name then
    raise exception 'The moved brick and the history it leaves behind cannot share the name %.', btrim(p_brick_name);
  end if;

  select * into v_old
  from public.source_of_sales_bricks b
  where b.brick_id = btrim(p_brick_id)
  for update;
  if not found then
    raise exception 'That brick is no longer in the brick master. Reload the page and try again.';
  end if;
  if v_old.active is false then
    raise exception '% is switched off. Switch it back on before moving it.', v_old.brick_name;
  end if;
  if v_old.superseded_by_brick_id is not null then
    raise exception '% is kept only as history: it has already moved. Correct the brick it moved to instead.', v_old.brick_name;
  end if;

  select * into v_block
  from public.source_of_sales_blocks bl
  where upper(btrim(bl.block_code)) = upper(btrim(coalesce(p_block_code, '')))
  order by bl.block_code
  limit 1
  for share;
  if not found then
    raise exception 'The block you picked is not in the block master. Reload the page and try again.';
  end if;
  v_block_label := coalesce(
    nullif(btrim(v_block.display_name), ''),
    (select mb.brick_name from public.source_of_sales_bricks mb where mb.brick_id = v_block.master_brick_id),
    nullif(btrim(v_block.description), ''),
    v_block.block_code
  );
  if v_block.active is false then
    raise exception 'The block % is switched off. Switch it back on before moving a brick into it.', v_block_label;
  end if;
  if upper(btrim(v_block.block_code)) = upper(btrim(v_old.block_code)) then
    raise exception '% is already in that block.', v_old.brick_name;
  end if;

  select a.area_name into v_from_area from public.source_of_sales_areas a where a.area_code = v_old.area_code;
  select a.area_name into v_to_area from public.source_of_sales_areas a where a.area_code = v_block.area_code;
  v_from_area := coalesce(v_from_area, v_old.area_code);
  v_to_area := coalesce(v_to_area, v_block.area_code);

  -- A change already waiting on the Mapping guard would land on the wrong side of the move once
  -- approved (onto the history brick, or into a second hold for the same pharmacy).
  select count(*)::integer into v_pending
  from public.sos_map_change_holds h
  where h.status = 'pending'
    and (
      (h.table_name = 'source_of_sales_customer_map'
       and (upper(btrim(coalesce(h.before_json->>'brick_id', ''))) = upper(v_old.brick_id)
            or upper(btrim(coalesce(h.after_json->>'brick_id', ''))) = upper(v_old.brick_id)))
      or (h.table_name = 'source_of_sales_bricks'
          and upper(btrim(h.entity_key)) = upper(v_old.brick_id))
    );
  if v_pending > 0 then
    raise exception '% has % change(s) waiting for you on the Mapping guard. Decide those first, then move it.',
      v_old.brick_name, v_pending;
  end if;

  -- Brick names are unique by the owner's rule of 2026-09-11.
  if exists (
    select 1 from public.source_of_sales_bricks b
    where b.brick_id <> v_old.brick_id
      and b.normalized_brick_name = p_normalized_brick_name
  ) then
    raise exception 'Another brick is already named %. Pick a different name.', btrim(p_brick_name);
  end if;
  if exists (
    select 1 from public.source_of_sales_bricks b
    where b.brick_id <> v_old.brick_id
      and b.normalized_brick_name = p_normalized_historical_name
  ) then
    raise exception 'Another brick is already named %, the name % would keep as its history.',
      btrim(p_historical_name), v_old.brick_name;
  end if;

  -- The next "<block>-<n>" id. Skip any id that something already points at: the territory aliases
  -- hold references to ids that are not bricks, and a new brick must never inherit one.
  v_prefix := upper(btrim(v_block.block_code)) || '-';
  select coalesce(max(substr(b.brick_id, length(v_prefix) + 1)::bigint), 0) + 1 into v_seq
  from public.source_of_sales_bricks b
  where upper(left(b.brick_id, length(v_prefix))) = v_prefix
    and substr(b.brick_id, length(v_prefix) + 1) ~ '^[0-9]{1,9}$';
  loop
    v_new := v_prefix || v_seq::text;
    exit when not exists (select 1 from public.source_of_sales_bricks b where upper(btrim(b.brick_id)) = upper(v_new))
      and not exists (
        select 1 from public.source_of_sales_territory_aliases a
        where a.target_type = 'brick' and upper(btrim(a.target_code)) = upper(v_new))
      and not exists (select 1 from public.source_of_sales_customer_map m where upper(btrim(m.brick_id)) = upper(v_new))
      and not exists (select 1 from public.source_of_sales_import_rows r where r.brick_id = v_new)
      and not exists (select 1 from public.source_of_sales_customer_ai_answers x where upper(btrim(x.brick_id)) = upper(v_new))
      and not exists (select 1 from public.direct_order_pharmacies d where upper(btrim(d.brick_id)) = upper(v_new))
      and not exists (
        select 1 from public.direct_order_pharmacy_distributor_codes c
        where upper(btrim(c.mapped_brick_id)) = upper(v_new));
    v_seq := v_seq + 1;
    v_tries := v_tries + 1;
    if v_tries >= 500 then
      raise exception 'No free brick number was found in the block %. Nothing was moved.', v_block_label;
    end if;
  end loop;

  insert into public.source_of_sales_bricks (
    brick_id, brick_name, normalized_brick_name, block_code, area_code, region_code,
    description, normalized_description, active, effective_from, source_file, source_sheet
  ) values (
    v_new, btrim(p_brick_name), p_normalized_brick_name, v_block.block_code, v_block.area_code, v_block.region_code,
    btrim(p_brick_name), p_normalized_brick_name, true, v_today,
    'Database Mapping brick move ' || to_char(v_today, 'YYYY-MM-DD'), 'Bricks'
  );

  -- The old brick keeps its area (so the brick guard passes) and stays active (so published months
  -- keep resolving). Only its name, its description and its dates say it is history now. An end
  -- date it already carries is kept; otherwise it ends yesterday (never before it began).
  v_until := least(coalesce(v_old.effective_to, v_today - 1), v_today - 1);
  if v_old.effective_from is not null and v_until < v_old.effective_from then
    v_until := v_old.effective_from;
  end if;
  update public.source_of_sales_bricks b
  set brick_name             = btrim(p_historical_name),
      normalized_brick_name  = p_normalized_historical_name,
      description            = format('%s — %s up to %s (historical; moved to %s)',
                                      v_old.brick_name, v_from_area,
                                      to_char(v_until, 'FMDD FMMonth YYYY'), v_to_area),
      effective_to           = v_until,
      superseded_by_brick_id = v_new,
      updated_at             = now()
  where b.brick_id = v_old.brick_id;

  -- Through the mapping guard: a held row is dropped from this statement and filed as a hold, so the
  -- held count is read from the holds, never from what came back.
  with moved as (
    update public.source_of_sales_customer_map m
    set brick_id    = v_new,
        area_code   = v_block.area_code,
        region_code = v_block.region_code,
        updated_at  = now()
    where m.brick_id = v_old.brick_id
    returning m.active
  )
  select count(*) filter (where mv.active)::integer,
         count(*) filter (where mv.active is not true)::integer
    into v_customers_moved, v_switched_off
  from moved mv;

  select count(*)::integer into v_customers_held
  from public.sos_map_change_holds h
  where h.status = 'pending'
    and h.table_name = 'source_of_sales_customer_map'
    and h.before_json->>'brick_id' = v_old.brick_id
    and h.after_json->>'brick_id' = v_new;

  with moved as (
    update public.source_of_sales_territory_aliases a
    set target_code = v_new, updated_at = now()
    where a.target_type = 'brick'
      and upper(btrim(a.target_code)) = upper(v_old.brick_id)
    returning 1
  )
  select count(*)::integer into v_aliases from moved;

  with moved as (
    update public.direct_order_pharmacies d
    set brick_id    = v_new,
        area_code   = v_block.area_code,
        region_code = v_block.region_code,
        updated_at  = now()
    where d.brick_id = v_old.brick_id
    returning 1
  )
  select count(*)::integer into v_pharmacies from moved;

  with moved as (
    update public.direct_order_pharmacy_distributor_codes c
    set mapped_brick_id    = v_new,
        mapped_area_code   = v_block.area_code,
        mapped_region_code = v_block.region_code
    where c.mapped_brick_id = v_old.brick_id
    returning 1
  )
  select count(*)::integer into v_codes from moved;

  with moved as (
    update public.source_of_sales_customer_ai_answers x
    set brick_id = v_new
    where x.brick_id = v_old.brick_id
    returning 1
  )
  select count(*)::integer into v_answers from moved;

  v_sales := public.sos_move_brick_sales(v_old.brick_id);

  return jsonb_build_object(
    'newBrickId',            v_new,
    'newBrickName',          btrim(p_brick_name),
    'historicalName',        btrim(p_historical_name),
    'fromAreaName',          v_from_area,
    'toAreaName',            v_to_area,
    'toBlockLabel',          v_block_label,
    'customersMoved',        v_customers_moved,
    'switchedOffMoved',      v_switched_off,
    'customersHeld',         v_customers_held,
    'aliasesMoved',          v_aliases,
    'directPharmaciesMoved', v_pharmacies,
    'directCodesMoved',      v_codes,
    'aiAnswersMoved',        v_answers
  ) || v_sales;
end;
$function$;

-- ── After the owner approves a held pharmacy ───────────────────────────────────────────────────
-- sos_map_guard_decide moves the map row only. When the approved hold is a brick move (the row's
-- old brick was superseded by the brick it now points at), this moves that pharmacy's
-- unlocked-month sales too. Anything else returns null and changes nothing.
create or replace function public.sos_move_brick_sales_after_hold(p_hold_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  h           public.sos_map_change_holds;
  v_before    text;
  v_successor text;
begin
  select * into h from public.sos_map_change_holds where id = p_hold_id;
  if not found or h.status <> 'approved' or h.table_name <> 'source_of_sales_customer_map' then
    return null;
  end if;

  v_before := h.before_json->>'brick_id';
  select b.superseded_by_brick_id into v_successor
  from public.source_of_sales_bricks b
  where b.brick_id = v_before;
  if v_successor is null or v_successor is distinct from h.after_json->>'brick_id' then
    return null;
  end if;

  return public.sos_move_brick_sales(v_before);
end;
$function$;

-- ── Rebuilding the moved files' totals, one file per claim ─────────────────────────────────────
create or replace function public.sos_claim_brick_move_file(p_old_brick text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.source_of_sales_brick_move_files;
begin
  update public.source_of_sales_brick_move_files f
  set refresh_started_at = now()
  from (
    select f2.old_brick_id, f2.batch_id
    from public.source_of_sales_brick_move_files f2
    where f2.refreshed_at is null
      and (p_old_brick is null or f2.old_brick_id = btrim(p_old_brick))
      and (f2.refresh_started_at is null or f2.refresh_started_at < now() - interval '5 minutes')
    order by f2.moved_at, f2.batch_id
    limit 1
    for update skip locked
  ) pick
  where f.old_brick_id = pick.old_brick_id
    and f.batch_id = pick.batch_id
  returning f.* into v_row;

  if v_row.batch_id is null then
    return null;
  end if;
  return jsonb_build_object('oldBrickId', v_row.old_brick_id, 'batchId', v_row.batch_id, 'movedAt', v_row.moved_at);
end;
$function$;

-- Releases the claim. The file counts as rebuilt only when the rebuild succeeded AND no later move
-- re-stamped more of its rows while it ran (moved_at unchanged since the claim).
create or replace function public.sos_finish_brick_move_file(
  p_old_brick text,
  p_batch_id  uuid,
  p_moved_at  timestamptz,
  p_refreshed boolean
)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  with done as (
    update public.source_of_sales_brick_move_files f
    set refreshed_at       = case when p_refreshed and f.moved_at = p_moved_at then now() else f.refreshed_at end,
        refresh_started_at = null
    where f.old_brick_id = btrim(p_old_brick)
      and f.batch_id = p_batch_id
    returning f.refreshed_at is not null as refreshed
  )
  select coalesce((select d.refreshed from done d), false);
$function$;

revoke all on function public.sos_move_brick_sales(text) from public, anon, authenticated;
revoke all on function public.sos_relocate_brick(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.sos_move_brick_sales_after_hold(bigint) from public, anon, authenticated;
revoke all on function public.sos_claim_brick_move_file(text) from public, anon, authenticated;
revoke all on function public.sos_finish_brick_move_file(text, uuid, timestamptz, boolean) from public, anon, authenticated;

grant execute on function public.sos_move_brick_sales(text) to service_role;
grant execute on function public.sos_relocate_brick(text, text, text, text, text, text, text) to service_role;
grant execute on function public.sos_move_brick_sales_after_hold(bigint) to service_role;
grant execute on function public.sos_claim_brick_move_file(text) to service_role;
grant execute on function public.sos_finish_brick_move_file(text, uuid, timestamptz, boolean) to service_role;

-- sos_map_guard_decide: the brick release path must carry the brick's BLOCK across areas.
--
-- A brick's geography is pinned by two composite foreign keys:
--   • source_of_sales_customer_map (brick_id, area_code, region_code) -> source_of_sales_bricks
--   • source_of_sales_bricks       (block_code, area_code, region_code) -> source_of_sales_blocks
-- A block belongs to exactly one area, so moving a brick from one area to another (e.g. القرشية from
-- a Gharbia 2 / Mahalla block to a Gharbia 1 / Tanta block) must change block_code AND area_code
-- together, or the block->blocks FK rejects the row.
--
-- Until now the release path (approve a held brick move) copied only area_code and region_code out of
-- the hold and left block_code alone. That is fine for a move WITHIN a block's area, but a genuine
-- cross-block relocation could never be applied: sos_map_guard_decide raised
--   "(block_code, area_code, region_code)=(<old block>, <new area>, <region>) is not present in
--    source_of_sales_blocks"
-- and rolled back. The held change already carries the intended block in after_json (to_jsonb(new));
-- this makes the release honour it. coalesce keeps today's block for a same-block move, where the
-- held after_json's block equals the current one anyway.
--
-- Additive and idempotent: CREATE OR REPLACE of the whole function, the customer_map and areas
-- branches unchanged from 20260913020000 (which pinned confidence/mapped_by onto the map branch).

CREATE OR REPLACE FUNCTION public.sos_map_guard_decide(p_hold_id bigint, p_decision text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  h public.sos_map_change_holds;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected, got %', p_decision;
  end if;

  select * into h from public.sos_map_change_holds where id = p_hold_id for update;
  if not found then
    raise exception 'hold % does not exist', p_hold_id;
  end if;
  if h.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', format('already %s', h.status));
  end if;

  if p_decision = 'approved' then
    -- The permit is scoped to THIS transaction, THIS table and THIS entity, and names the hold it
    -- came from. It cannot release anything else, and it dies with the transaction.
    insert into public.sos_map_guard_permits (txid, table_name, entity_key, hold_id)
    values (txid_current(), h.table_name, h.entity_key, h.id)
    on conflict (txid, table_name, entity_key) do update set hold_id = excluded.hold_id;

    if h.table_name = 'source_of_sales_customer_map' then
      -- confidence and mapped_by travel with the move: a ruling that lands at its old confidence
      -- does not bind, and the next automatic remap overwrites it.
      update public.source_of_sales_customer_map m
      set brick_id    = h.after_json->>'brick_id',
          area_code   = h.after_json->>'area_code',
          region_code = h.after_json->>'region_code',
          source      = h.after_json->>'source',
          active      = coalesce((h.after_json->>'active')::boolean, m.active),
          confidence  = coalesce((h.after_json->>'confidence')::int, m.confidence),
          mapped_by   = coalesce(h.after_json->>'mapped_by', m.mapped_by),
          updated_at  = now()
      where m.id = h.row_id;
    elsif h.table_name = 'source_of_sales_bricks' then
      -- block_code travels with the move, or a cross-block area relocation fails the block->blocks FK.
      update public.source_of_sales_bricks b
      set block_code  = coalesce(h.after_json->>'block_code', b.block_code),
          area_code   = h.after_json->>'area_code',
          region_code = h.after_json->>'region_code',
          updated_at  = now()
      where upper(trim(b.brick_id)) = upper(trim(h.entity_key));
    elsif h.table_name = 'source_of_sales_areas' then
      update public.source_of_sales_areas a
      set region_code = h.after_json->>'region_code', updated_at = now()
      where upper(trim(a.area_code)) = upper(trim(h.entity_key));
    else
      raise exception 'hold % names an unknown table %', p_hold_id, h.table_name;
    end if;

    delete from public.sos_map_guard_permits where txid = txid_current();
  end if;

  update public.sos_map_change_holds
  set status = p_decision, decided_at = now(), decided_by = p_actor
  where id = p_hold_id;

  -- Housekeeping: a transaction that died mid-flight leaves its permit behind, and a stale permit is
  -- exactly the thing that must not linger.
  delete from public.sos_map_guard_permits where issued_at < now() - interval '1 hour';

  return jsonb_build_object('ok', true, 'holdId', p_hold_id, 'decision', p_decision, 'table', h.table_name);
end;
$function$;

revoke execute on function public.sos_map_guard_decide(bigint, text, text) from public, anon, authenticated;
grant  execute on function public.sos_map_guard_decide(bigint, text, text) to service_role;

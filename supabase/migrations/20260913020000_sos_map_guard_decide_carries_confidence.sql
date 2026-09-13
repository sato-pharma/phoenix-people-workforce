-- A released ruling must carry its confidence, or it does not bind.
--
-- WHAT WENT WRONG. `sos_map_guard_decide`, releasing a hold on source_of_sales_customer_map, copied
-- brick_id, area_code, region_code, source and active out of the hold's after_json — and nothing
-- else. `confidence` and `mapped_by` kept their PRE-HOLD values. An owner ruling only binds at
-- confidence = 100 (source ~ '^(owner|sheet-verified|manual)'), so every ruling released through the
-- guard landed on the map at its old confidence (null, 10, 35, 56) and stayed exposed to the automatic
-- remaps it was supposed to outrank.
--
-- Measured and repaired by hand on production 2026-09-13, about 08:13 Cairo: 29 rulings released
-- earlier (holds 122-128, 224, 233-249, 253-256) plus 185 released that morning (holds 257-441) were
-- set to confidence 100. Pre-images: is_twin_backup_20260911.release185_pre_20260913 (map rows) and
-- is_twin_backup_20260911.release185_holds_pre_20260913 (holds).
--
-- THE FIX. The customer-map branch now also writes
--   confidence = coalesce((after_json->>'confidence')::int, m.confidence)
--   mapped_by  = coalesce(after_json->>'mapped_by',       m.mapped_by)
-- so the row that lands is the row the hold described. A hold whose after_json carries neither key
-- keeps the row's own values, exactly as before.
--
-- EVERYTHING ELSE IS UNCHANGED, deliberately: the permit is still scoped to this transaction, this
-- table and this entity and names its hold; it is deleted after the write; stale permits are purged.
-- The brick and area branches are untouched.
--
-- WHY NO NEW HOLD IS RAISED. sos_map_guard_customer only holds a change that moves brick_id or
-- area_code (`if not v_moves then return new`), and the move itself is released by the permit, so
-- writing confidence and mapped_by in the same UPDATE adds nothing for the trigger to judge.
--
-- This changes future releases only. It rewrites no row: at the time of writing there were no
-- pending customer-map holds, and no approved hold carrying confidence 100 whose map row read
-- anything else.

begin;

create or replace function public.sos_map_guard_decide(
  p_hold_id  bigint,
  p_decision text,
  p_actor    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
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
      update public.source_of_sales_bricks b
      set area_code = h.after_json->>'area_code', region_code = h.after_json->>'region_code', updated_at = now()
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
$$;

revoke execute on function public.sos_map_guard_decide(bigint, text, text) from public, anon, authenticated;
grant execute on function public.sos_map_guard_decide(bigint, text, text) to service_role;

commit;

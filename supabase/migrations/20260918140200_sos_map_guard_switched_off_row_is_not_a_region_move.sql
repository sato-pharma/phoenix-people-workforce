-- The mapping guard stops calling the re-map of a switched-off customer a region move.
--
-- WHAT WENT WRONG. sos_map_guard_customer holds a customer-map UPDATE that changes the brick or area
-- when the old and new areas sit in different regions, and a held write is silently dropped. It
-- judged the OLD side by whatever brick the row still carried - including a row that had been
-- switched off. Switching a mapping off keeps its brick (so the takeback can be undone), but that
-- brick is discarded: the importer's crosswalk and the history heal read active rows only, so the
-- row assigns nothing to any region. Re-mapping such a row is a NEW mapping, exactly like an INSERT,
-- which the guard only logs - yet it was held as "moves the customer from region X to Y" and dropped.
--
-- Latent until now (every one of the 3,238 holds on file has an active old row), but it would have
-- hit the next step directly: the 199 Pharma Overseas mappings and the 545 weak AI guesses taken back
-- on 2026-09-18 are switched-off rows that still carry their old bricks, and re-mapping them with the
-- free steps would have been held and dropped wherever the new brick falls in another region.
--
-- THE FIX. The region reason applies only when the old row is live (active is not false). The other
-- reason is untouched: a row carrying a decision of the owner's (source owner-*, final-new-* or
-- sheet-verified) is still held whether or not it is switched on, and every applied change is still
-- written to sos_map_change_log with its before and after. Everything else is the live definition
-- (20260911013000_sos_mapping_guard_permit_not_a_flag.sql), unchanged.

begin;

create or replace function public.sos_map_guard_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_reasons  text[] := '{}';
  v_moves    boolean;
  v_permit   bigint;
  v_actor    text := nullif(current_setting('phoenix.actor', true), '');
  v_key      text;
  v_log_id   bigint;
  v_old_rgn  text;
  v_new_rgn  text;
begin
  if tg_op = 'DELETE' then
    v_key := coalesce(old.distributor_code, '?') || ' / ' || coalesce(old.customer_code, '?');
    v_permit := public.sos_map_guard_permit_for(tg_table_name, v_key);
    if v_permit is null and (old.source ~ '^(owner-|final-new-)' or old.source = 'sheet-verified') then
      insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, app_actor)
      values (tg_table_name, old.id, v_key, 'delete', 'held',
              array['deletes a mapping that carried a decision of yours'], to_jsonb(old), v_actor)
      returning id into v_log_id;
      insert into public.sos_map_change_holds (log_id, table_name, row_id, entity_key, reasons, before_json, after_json, db_role, app_actor)
      values (v_log_id, tg_table_name, old.id, v_key,
              array['deletes a mapping that carried a decision of yours'], to_jsonb(old), '{}'::jsonb, current_user, v_actor);
      return null;
    end if;
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, app_actor)
    values (tg_table_name, old.id, v_key, 'delete', 'applied',
            case when v_permit is null then '{}'::text[] else array[format('released by hold %s', v_permit)] end,
            to_jsonb(old), v_actor);
    return old;
  end if;

  v_key := coalesce(new.distributor_code, '?') || ' / ' || coalesce(new.customer_code, '?');

  if tg_op = 'INSERT' then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, after_json, app_actor)
    values (tg_table_name, new.id, v_key, 'insert', 'applied', to_jsonb(new), v_actor);
    return new;
  end if;

  v_moves := upper(trim(coalesce(old.brick_id, ''))) is distinct from upper(trim(coalesce(new.brick_id, '')))
          or upper(trim(coalesce(old.area_code, ''))) is distinct from upper(trim(coalesce(new.area_code, '')));
  if not v_moves then
    return new;
  end if;

  -- A permit names a hold. "you approved it" is gone: the log now says WHICH decision released this,
  -- so an approval that never happened cannot be asserted by the writer.
  v_permit := public.sos_map_guard_permit_for(tg_table_name, v_key);
  if v_permit is not null then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, new.id, v_key, 'update', 'applied',
            array[format('released by hold %s', v_permit)], to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  if old.source ~ '^(owner-|final-new-)' or old.source = 'sheet-verified' then
    v_reasons := array_append(v_reasons, 'overwrites a mapping decision of yours');
  end if;

  -- Only a LIVE row has a region to move out of. A switched-off row's brick is discarded - nothing
  -- reads it - so re-mapping it is a new mapping, judged like an INSERT.
  if old.active is not false then
    v_old_rgn := public.sos_map_region_of_area(old.area_code);
    v_new_rgn := public.sos_map_region_of_area(new.area_code);
    if v_old_rgn is distinct from v_new_rgn then
      v_reasons := array_append(v_reasons, format('moves the customer from region %s to %s',
                                                  coalesce(v_old_rgn, '(none)'), coalesce(v_new_rgn, '(none)')));
    end if;
  end if;

  if array_length(v_reasons, 1) is null then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, before_json, after_json, app_actor)
    values (tg_table_name, new.id, v_key, 'update', 'applied', to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
  values (tg_table_name, new.id, v_key, 'update', 'held', v_reasons, to_jsonb(old), to_jsonb(new), v_actor)
  returning id into v_log_id;
  insert into public.sos_map_change_holds (log_id, table_name, row_id, entity_key, reasons, before_json, after_json, db_role, app_actor)
  values (v_log_id, tg_table_name, new.id, v_key, v_reasons, to_jsonb(old), to_jsonb(new), current_user, v_actor);

  return null;
end;
$function$;

revoke execute on function public.sos_map_guard_customer() from public, anon, authenticated;

commit;

-- Close the hole in the mapping guard: a writer could wave itself through.
--
-- WHAT WENT WRONG. 20260910230000 gated its bypass on `phoenix.map_guard_bypass`, a session setting,
-- and its own comment claimed that flag was "the whole security property" and was "set by
-- sos_map_guard_decide and by nothing else". The second half was an assumption, never an
-- enforcement. A GUC is something the CALLER asserts about ITSELF, so any connection that could
-- write to the mapping table could switch the guard off for its own transaction.
--
-- Measured on production the same night, twenty minutes after arming. One session set the flag and
-- moved 24 customers straight through: every one of the 24 crossed a region and three overwrote a
-- mapping decision of the owner's, so all 24 would have been held. None were. Worse, the log
-- recorded each as "you approved it", so the audit trail asserted an approval that never happened.
--
-- THE FIX. The release path now issues a PERMIT — a row naming this transaction, this table and this
-- entity, tied to the hold it came from — into a table that has no grants to anyone. The trigger
-- looks for that permit instead of trusting a flag. `sos_map_guard_decide` and the triggers are
-- SECURITY DEFINER and run as the owner, so they can use it; nothing else can insert one.
--
-- WHAT THIS DOES AND DOES NOT BUY. It does not defend against the table owner, and nothing can: a
-- superuser can drop the trigger outright. What it removes is the case that actually happened —
-- a session reading the migration, finding a documented switch, and flipping it because that looked
-- like the way to proceed. Forging a release now means inventing a hold and inserting a permit for
-- it, which is a deliberate act rather than one line, and the log names the hold that authorised
-- every applied change so a forged one is visible afterwards.

begin;

create table if not exists public.sos_map_guard_permits (
  txid        bigint      not null,
  table_name  text        not null,
  entity_key  text        not null,
  hold_id     bigint      not null,
  issued_at   timestamptz not null default now(),
  primary key (txid, table_name, entity_key)
);

comment on table public.sos_map_guard_permits is
  'One-transaction permission to move a mapping row past the guard. Written ONLY by sos_map_guard_decide, which runs as the owner. No role holds any grant here, and that absence is the security property — the previous design used a session setting the caller could set about itself.';

alter table public.sos_map_guard_permits enable row level security;
revoke all on public.sos_map_guard_permits from public, anon, authenticated;
-- service_role is named explicitly rather than left to inherit: revoking PUBLIC strips it too, and
-- the point here is that it gets nothing back.
revoke all on public.sos_map_guard_permits from service_role;

/**
 * Is this exact change permitted, in this transaction? Returns the hold that authorised it.
 *
 * SECURITY DEFINER so the trigger can read a table nothing else may touch.
 */
create or replace function public.sos_map_guard_permit_for(p_table text, p_entity text)
returns bigint
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.hold_id
  from public.sos_map_guard_permits p
  where p.txid = txid_current() and p.table_name = p_table and p.entity_key = p_entity
  limit 1;
$$;

revoke execute on function public.sos_map_guard_permit_for(text, text) from public, anon, authenticated;

-- ── The three triggers, now asking for a permit instead of reading a flag ──────────────────────

create or replace function public.sos_map_guard_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
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

  v_old_rgn := public.sos_map_region_of_area(old.area_code);
  v_new_rgn := public.sos_map_region_of_area(new.area_code);
  if v_old_rgn is distinct from v_new_rgn then
    v_reasons := array_append(v_reasons, format('moves the customer from region %s to %s',
                                                coalesce(v_old_rgn, '(none)'), coalesce(v_new_rgn, '(none)')));
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
$$;

create or replace function public.sos_map_guard_brick()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_permit bigint;
  v_actor  text := nullif(current_setting('phoenix.actor', true), '');
  v_reason text;
  v_log_id bigint;
  v_count  bigint;
begin
  if upper(trim(coalesce(old.area_code, ''))) is not distinct from upper(trim(coalesce(new.area_code, ''))) then
    return new;
  end if;
  v_permit := public.sos_map_guard_permit_for(tg_table_name, old.brick_id);
  if v_permit is not null then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, null, old.brick_id, 'update', 'applied',
            array[format('released by hold %s', v_permit)], to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  select count(*) into v_count from public.source_of_sales_customer_map m
  where m.active is true and upper(trim(m.brick_id)) = upper(trim(old.brick_id));
  v_reason := format('moves brick %s from area %s to %s, carrying %s customer mapping(s) with it',
                     old.brick_id, coalesce(old.area_code, '(none)'), coalesce(new.area_code, '(none)'), v_count);

  insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
  values (tg_table_name, null, old.brick_id, 'update', 'held', array[v_reason], to_jsonb(old), to_jsonb(new), v_actor)
  returning id into v_log_id;
  insert into public.sos_map_change_holds (log_id, table_name, row_id, entity_key, reasons, before_json, after_json, db_role, app_actor)
  values (v_log_id, tg_table_name, 0, old.brick_id, array[v_reason], to_jsonb(old), to_jsonb(new), current_user, v_actor);
  return null;
end;
$$;

create or replace function public.sos_map_guard_area()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_permit bigint;
  v_actor  text := nullif(current_setting('phoenix.actor', true), '');
  v_reason text;
  v_log_id bigint;
begin
  if upper(trim(coalesce(old.region_code, ''))) is not distinct from upper(trim(coalesce(new.region_code, ''))) then
    return new;
  end if;
  v_permit := public.sos_map_guard_permit_for(tg_table_name, old.area_code);
  if v_permit is not null then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, null, old.area_code, 'update', 'applied',
            array[format('released by hold %s', v_permit)], to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  v_reason := format('moves area %s from region %s to %s',
                     old.area_code, coalesce(old.region_code, '(none)'), coalesce(new.region_code, '(none)'));
  insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
  values (tg_table_name, null, old.area_code, 'update', 'held', array[v_reason], to_jsonb(old), to_jsonb(new), v_actor)
  returning id into v_log_id;
  insert into public.sos_map_change_holds (log_id, table_name, row_id, entity_key, reasons, before_json, after_json, db_role, app_actor)
  values (v_log_id, tg_table_name, 0, old.area_code, array[v_reason], to_jsonb(old), to_jsonb(new), current_user, v_actor);
  return null;
end;
$$;

-- ── The release path, which is the only thing that may issue a permit ──────────────────────────

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
      update public.source_of_sales_customer_map m
      set brick_id    = h.after_json->>'brick_id',
          area_code   = h.after_json->>'area_code',
          region_code = h.after_json->>'region_code',
          source      = h.after_json->>'source',
          active      = coalesce((h.after_json->>'active')::boolean, m.active),
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

-- Any permit left over from the old design's window.
delete from public.sos_map_guard_permits;

commit;

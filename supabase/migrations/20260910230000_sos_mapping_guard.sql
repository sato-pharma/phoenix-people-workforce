-- The mapping guard — nothing re-points a customer, a brick or an area without a record, and the
-- risky ones do not land until the owner says so.
--
-- WHY THIS EXISTS. `source_of_sales_mapping_audit` is written by the application routes, through
-- `writeMappingAudit`. Measured on production 2026-09-10, there were ZERO triggers on
-- `source_of_sales_customer_map` and `source_of_sales_bricks`, so anything written by a script, a
-- migration or a psql session left no trace at all. That day 144 rows were re-pointed by direct SQL
-- and not one produced an audit row, while 15 of them silently overwrote a mapping decision the
-- owner had made in August. He asked for a guard the same evening: tell me what changed, and hold
-- the wrong-looking ones. A trigger is the only level that sees every writer.
--
-- WHAT IS HELD, AND WHY IT IS NARROW. Measured against a full day of real traffic before this was
-- written — 3,702 application edits plus the 144 direct ones:
--
--     changes that leave brick and area alone      3,633   pass, not even logged (see below)
--     changes that actually move a customer          139   logged
--     of those, held for the owner                    66
--
-- Three iterations were needed to get there, and the discarded ones are worth recording because
-- each looked right:
--
--   1. "old source was a ruling AND the new source is not" held NOTHING, because a writer chooses
--      its own `source` string and the scripts that overwrote 15 rulings stamped themselves
--      `owner-file-resolved-...`. A self-asserted label can never be the test.
--   2. Dropping the new-source half held 3,666 of 3,702 — 99% of a normal day — because most rows
--      already carry an owner decision and the app touches them constantly for reasons that have
--      nothing to do with geography.
--   3. Adding "and the change actually moves the customer" brought it to 66. That is the rule below.
--
-- A first attempt to size this from the audit table's `before_json` read `region_code`, which is
-- present in only 69 of 3,702 payloads, and reported zero holds. The trigger reads OLD and NEW,
-- which always carry every column, and that is a second reason the guard belongs here.
--
-- WHAT IS NOT LOGGED. A change that leaves `brick_id` and `area_code` untouched is not a mapping
-- change; it is a confidence or actor backfill, and the application's own audit already records it.
-- Logging all 3,633 of those daily would bury the 139 that matter.
--
-- THE BYPASS IS THE WHOLE SECURITY PROPERTY. `phoenix.map_guard_bypass` is set, transaction-locally,
-- by `sos_map_guard_decide` and by nothing else. That is what makes "the owner approved it" a
-- different thing from "the writer claimed to be the owner".

-- ── The record of every mapping move, whoever made it ──────────────────────────────────────────

create table if not exists public.sos_map_change_log (
  id             bigserial primary key,
  table_name     text        not null,
  row_id         bigint,
  entity_key     text        not null,
  action         text        not null check (action in ('insert', 'update', 'delete')),
  outcome        text        not null check (outcome in ('applied', 'held')),
  reasons        text[]      not null default '{}',
  before_json    jsonb,
  after_json     jsonb,
  db_role        text        not null default current_user,
  app_actor      text,
  created_at     timestamptz not null default now()
);

create index if not exists sos_map_change_log_created_idx on public.sos_map_change_log (created_at desc);
create index if not exists sos_map_change_log_outcome_idx on public.sos_map_change_log (outcome, created_at desc);

comment on table public.sos_map_change_log is
  'Every change that MOVES a customer, brick or area, from any writer including direct SQL. Written by a trigger, so a script cannot avoid it.';
comment on column public.sos_map_change_log.app_actor is
  'Whoever the application named in phoenix.actor. Null for a direct SQL session, which is itself the signal.';

-- ── The holding pen ───────────────────────────────────────────────────────────────────────────

create table if not exists public.sos_map_change_holds (
  id           bigserial primary key,
  log_id       bigint      references public.sos_map_change_log(id) on delete set null,
  table_name   text        not null,
  row_id       bigint      not null,
  entity_key   text        not null,
  reasons      text[]      not null,
  before_json  jsonb       not null,
  after_json   jsonb       not null,
  db_role      text        not null,
  app_actor    text,
  status       text        not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'superseded')),
  notified_at  timestamptz,
  decided_at   timestamptz,
  decided_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists sos_map_change_holds_pending_idx
  on public.sos_map_change_holds (status, created_at desc);
create index if not exists sos_map_change_holds_unnotified_idx
  on public.sos_map_change_holds (notified_at, created_at) where status = 'pending';

comment on table public.sos_map_change_holds is
  'Mapping moves that did NOT land. The row still holds its old value; after_json is what was asked for.';

-- ── The guard ─────────────────────────────────────────────────────────────────────────────────

create or replace function public.sos_map_region_of_area(p_area_code text)
returns text
language sql
stable
set search_path = public, pg_catalog
as $$
  select upper(trim(a.region_code))
  from public.source_of_sales_areas a
  where upper(trim(a.area_code)) = upper(trim(p_area_code))
  limit 1;
$$;

create or replace function public.sos_map_guard_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_reasons  text[] := '{}';
  v_moves    boolean;
  v_bypass   text   := coalesce(current_setting('phoenix.map_guard_bypass', true), '');
  v_actor    text   := nullif(current_setting('phoenix.actor', true), '');
  v_key      text;
  v_log_id   bigint;
  v_old_rgn  text;
  v_new_rgn  text;
begin
  if tg_op = 'DELETE' then
    v_key := coalesce(old.distributor_code, '?') || ' / ' || coalesce(old.customer_code, '?');
    -- A delete cannot be judged by what it moves; it removes the mapping entirely. Only a row
    -- carrying one of his decisions is worth stopping, and nothing in the app deletes here at all.
    if v_bypass <> 'on' and (old.source ~ '^(owner-|final-new-)' or old.source = 'sheet-verified') then
      insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, app_actor)
      values (tg_table_name, old.id, v_key, 'delete', 'held',
              array['deletes a mapping that carried a decision of yours'], to_jsonb(old), v_actor)
      returning id into v_log_id;
      insert into public.sos_map_change_holds (log_id, table_name, row_id, entity_key, reasons, before_json, after_json, db_role, app_actor)
      values (v_log_id, tg_table_name, old.id, v_key,
              array['deletes a mapping that carried a decision of yours'], to_jsonb(old), '{}'::jsonb, current_user, v_actor);
      return null;
    end if;
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, before_json, app_actor)
    values (tg_table_name, old.id, v_key, 'delete', 'applied', to_jsonb(old), v_actor);
    return old;
  end if;

  v_key := coalesce(new.distributor_code, '?') || ' / ' || coalesce(new.customer_code, '?');

  if tg_op = 'INSERT' then
    -- A new mapping overwrites nothing, so it is recorded and allowed.
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, after_json, app_actor)
    values (tg_table_name, new.id, v_key, 'insert', 'applied', to_jsonb(new), v_actor);
    return new;
  end if;

  v_moves := upper(trim(coalesce(old.brick_id, ''))) is distinct from upper(trim(coalesce(new.brick_id, '')))
          or upper(trim(coalesce(old.area_code, ''))) is distinct from upper(trim(coalesce(new.area_code, '')));

  -- Not a mapping change. The application's own audit covers these and there are ~3,600 a day.
  if not v_moves then
    return new;
  end if;

  if v_bypass = 'on' then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, new.id, v_key, 'update', 'applied', array['you approved it'], to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  -- The row being overwritten carried a decision of his. The INCOMING source is never consulted:
  -- the writer chooses that string, and the scripts that overwrote 15 rulings on 2026-09-10 all
  -- stamped themselves `owner-...`.
  -- array_append, never `||` with a bare literal. `v_reasons || 'some text'` makes Postgres read
  -- the literal as an ARRAY literal and fail with "malformed array literal" the first time a rule
  -- fires — which is to say, never during ordinary traffic and always at the moment the guard is
  -- most needed. Staging caught it; production would have caught it on the first real hold.
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

  -- Returning NULL leaves the row exactly as it was. The change is in the holding pen, not lost.
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
  v_bypass text := coalesce(current_setting('phoenix.map_guard_bypass', true), '');
  v_actor  text := nullif(current_setting('phoenix.actor', true), '');
  v_reason text;
  v_log_id bigint;
  v_count  bigint;
begin
  if upper(trim(coalesce(old.area_code, ''))) is not distinct from upper(trim(coalesce(new.area_code, ''))) then
    return new;
  end if;
  if v_bypass = 'on' then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, null, old.brick_id, 'update', 'applied', array['you approved it'], to_jsonb(old), to_jsonb(new), v_actor);
    return new;
  end if;

  -- Moving a brick moves every customer sitting on it, which is why this is held whatever the
  -- reason. The count goes in the message so the size of the move is visible before approval.
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
  v_bypass text := coalesce(current_setting('phoenix.map_guard_bypass', true), '');
  v_actor  text := nullif(current_setting('phoenix.actor', true), '');
  v_reason text;
  v_log_id bigint;
begin
  if upper(trim(coalesce(old.region_code, ''))) is not distinct from upper(trim(coalesce(new.region_code, ''))) then
    return new;
  end if;
  if v_bypass = 'on' then
    insert into public.sos_map_change_log (table_name, row_id, entity_key, action, outcome, reasons, before_json, after_json, app_actor)
    values (tg_table_name, null, old.area_code, 'update', 'applied', array['you approved it'], to_jsonb(old), to_jsonb(new), v_actor);
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

drop trigger if exists sos_map_guard_customer_trg on public.source_of_sales_customer_map;
create trigger sos_map_guard_customer_trg
  before insert or update or delete on public.source_of_sales_customer_map
  for each row execute function public.sos_map_guard_customer();

drop trigger if exists sos_map_guard_brick_trg on public.source_of_sales_bricks;
create trigger sos_map_guard_brick_trg
  before update on public.source_of_sales_bricks
  for each row execute function public.sos_map_guard_brick();

drop trigger if exists sos_map_guard_area_trg on public.source_of_sales_areas;
create trigger sos_map_guard_area_trg
  before update on public.source_of_sales_areas
  for each row execute function public.sos_map_guard_area();

-- ── The decision ──────────────────────────────────────────────────────────────────────────────

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
    -- Transaction-local, so it cannot leak into anything else on this connection. This is the only
    -- place in the database that sets it.
    perform set_config('phoenix.map_guard_bypass', 'on', true);

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
      set area_code   = h.after_json->>'area_code',
          region_code = h.after_json->>'region_code',
          updated_at  = now()
      where upper(trim(b.brick_id)) = upper(trim(h.entity_key));
    elsif h.table_name = 'source_of_sales_areas' then
      update public.source_of_sales_areas a
      set region_code = h.after_json->>'region_code',
          updated_at  = now()
      where upper(trim(a.area_code)) = upper(trim(h.entity_key));
    else
      raise exception 'hold % names an unknown table %', p_hold_id, h.table_name;
    end if;
  end if;

  update public.sos_map_change_holds
  set status = p_decision, decided_at = now(), decided_by = p_actor
  where id = p_hold_id;

  return jsonb_build_object('ok', true, 'holdId', p_hold_id, 'decision', p_decision, 'table', h.table_name);
end;
$$;

-- EXECUTE on a function is granted to PUBLIC by default, and service_role inherits it that way, so
-- revoking from PUBLIC takes it from the application too. The grant below has to be explicit or the
-- review screen can hold changes and never release one.
--
-- ALL FOUR functions here are SECURITY DEFINER, including the three trigger bodies, and all four
-- are revoked. A trigger function needs no EXECUTE privilege at fire time — the check happens when
-- the trigger is CREATED, which is above — so revoking here costs the guard nothing and closes a
-- surface that would otherwise be callable by anyone holding the anon key. This repository has had
-- exactly that leak once already.
revoke execute on function public.sos_map_guard_decide(bigint, text, text) from public, anon, authenticated;
revoke execute on function public.sos_map_guard_customer() from public, anon, authenticated;
revoke execute on function public.sos_map_guard_brick() from public, anon, authenticated;
revoke execute on function public.sos_map_guard_area() from public, anon, authenticated;
revoke execute on function public.sos_map_region_of_area(text) from public, anon, authenticated;

-- Only the decide function is ever called by the application; the rest are reached by the triggers.
grant execute on function public.sos_map_guard_decide(bigint, text, text) to service_role;

comment on function public.sos_map_guard_decide(bigint, text, text) is
  'Approve or reject one held mapping change. Approving is the ONLY path that sets phoenix.map_guard_bypass, which is what separates "he approved it" from "the writer said it was his".';

-- ── Who may see the holds ─────────────────────────────────────────────────────────────────────
--
-- RLS on with no policy, which is the norm in this database, plus an explicit service_role grant.
-- Visibility in this app is application-scoped: the page gate restricts the screen to Super Admin,
-- and these rows never travel to a browser role. `before_json` carries whole customer rows, so a
-- stray `authenticated` grant here would expose the mapping table through a side door.

alter table public.sos_map_change_log   enable row level security;
alter table public.sos_map_change_holds enable row level security;

revoke all on public.sos_map_change_log   from anon, authenticated;
revoke all on public.sos_map_change_holds from anon, authenticated;

grant select                        on public.sos_map_change_log   to service_role;
grant select, update                on public.sos_map_change_holds to service_role;
grant usage, select on sequence public.sos_map_change_log_id_seq   to service_role;
grant usage, select on sequence public.sos_map_change_holds_id_seq to service_role;

-- phoenix_crm_save_plan writes only the plan items that changed.
--
-- WHAT THIS CHANGES: phoenix_crm_save_plan is replaced with its live body — the one in
--   20261010180118_phoenix_crm_seating_session.sql, copied verbatim — and ONE change: the items upsert is
--   aliased `t`, and its `on conflict … do update` gains a WHERE, so an item sent back exactly as it is
--   stored is left alone instead of being written again.
--
-- WHY (2026-10-16 Phoenix CRM performance audit): the plan board saves itself after every tick, and the
--   phone sends EVERY item of the week's open days on each save. Every one of those rows was rewritten
--   each time — a new row version, its index entries and its WAL — although a tick changes one item, or
--   none. A rep building a week saves it dozens of times, so most of the work in each save was writing
--   rows that had not changed.
--
-- WHAT DOES NOT CHANGE: which items a plan holds and every value on them (a changed item is written
--   exactly as before; a new item is inserted as before; an item the phone left out is deleted as
--   before), the count returned, the version bump, the 'saved' event and every refusal. The one thing
--   that stops moving is `phoenix_crm_plan_items.updated_at` on an UNCHANGED item. Only
--   crm_plan_entries_unified reads it: its `synced_at` is greatest(plan.updated_at, item.updated_at), and
--   the plan row's updated_at is still stamped on every save, so `synced_at` reads exactly as it did; the
--   view's own `updated_at` column passes the item's through, and no reader in the app or the database
--   selects it. There is no trigger on phoenix_crm_plan_items.
--
-- ROLLBACK: re-run the phoenix_crm_save_plan block of 20261010180118_phoenix_crm_seating_session.sql,
--   with its revoke and grant.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file is neither: one function is replaced, no row is written.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_save_plan(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_week date := nullif(p ->> 'week_start', '')::date;
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_days date[];
  v_plan public.phoenix_crm_plans%rowtype;
  v_items jsonb := p -> 'items';
  v_count integer;
begin
  if v_seat is null or v_line is null or v_actor is null or v_week is null
    or extract(isodow from v_week) <> 6
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_typeof(p -> 'editable_days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(distinct d.value::date), '{}'::date[])
  into v_days
  from jsonb_array_elements_text(p -> 'editable_days') d;

  if exists (select 1 from unnest(v_days) d where d < v_today or d < v_week or d > v_week + 5) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan
  from public.phoenix_crm_plans pl
  where pl.seat_id = v_seat
    and pl.week_start = v_week
    and pl.is_test = v_is_test
  for update;

  if not found then
    if coalesce(v_expected, 0) <> 0 then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    insert into public.phoenix_crm_plans (seat_id, line_code, week_start, status, version, created_by_hr_id, is_test)
    values (v_seat, v_line, v_week, 'draft', 1, v_actor, v_is_test)
    returning * into v_plan;

    insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, to_status, version)
    values (v_plan.id, 'created', v_actor, 'draft', 1);
  else
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:not_editable';
    end if;
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (plan_date date)
    where x.plan_date is null or not (x.plan_date = any (v_days))
  ) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, place_id uuid, list_type text)
    where not exists (
      select 1
      from public.phoenix_crm_customers c
      where c.id = x.customer_id
        and c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending')
        -- The session an item is filed in is the SEATING's when the place is seated in a polyclinic or
        -- centre (owner, 2026-10-10), otherwise the customer's own list, as before.
        and x.list_type = coalesce(
          (select pl.session from public.phoenix_crm_places pl where pl.id = x.place_id and pl.customer_id = c.id),
          c.list_type
        )
    )
  ) then
    raise exception 'phoenix_crm:customer_not_on_list';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, place_id uuid)
    where x.place_id is not null
      and not exists (
        select 1
        from public.phoenix_crm_places pl
        where pl.id = x.place_id
          and pl.customer_id = x.customer_id
          and pl.status = 'active'
      )
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  delete from public.phoenix_crm_plan_items i
  where i.plan_id = v_plan.id
    and i.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, customer_id uuid)
      where x.plan_date = i.plan_date
        and x.customer_id = i.customer_id
    );

  insert into public.phoenix_crm_plan_items as t (
    plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note
  )
  select distinct on (x.plan_date, x.customer_id)
    v_plan.id,
    x.plan_date,
    x.customer_id,
    x.place_id,
    x.list_type,
    coalesce(x.receives, false),
    x.start_minute,
    nullif(x.exception_type, ''),
    nullif(trim(coalesce(x.exception_note, '')), '')
  from jsonb_to_recordset(v_items) as x (
    plan_date date,
    customer_id uuid,
    place_id uuid,
    list_type text,
    receives boolean,
    start_minute integer,
    exception_type text,
    exception_note text
  )
  order by x.plan_date, x.customer_id
  on conflict (plan_id, plan_date, customer_id) do update
    set place_id = excluded.place_id,
        list_type = excluded.list_type,
        receives = excluded.receives,
        start_minute = excluded.start_minute,
        exception_type = excluded.exception_type,
        exception_note = excluded.exception_note,
        updated_at = now()
    -- An item sent back exactly as it is stored is left as it is (2026-10-16): every save carries every
    -- item of the open days, and rewriting the unchanged ones was most of a save's work.
    where (t.place_id, t.list_type, t.receives, t.start_minute, t.exception_type, t.exception_note)
      is distinct from
      (excluded.place_id, excluded.list_type, excluded.receives, excluded.start_minute, excluded.exception_type, excluded.exception_note);

  select count(*)::integer into v_count from public.phoenix_crm_plan_items i where i.plan_id = v_plan.id;

  update public.phoenix_crm_plans pl
  set version = pl.version + 1, updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, from_status, to_status, version, details)
  values (
    v_plan.id, 'saved', v_actor, v_plan.status, v_plan.status, v_plan.version,
    -- A save never changes the week's status, so on a week returned for ONE day this event is the
    -- latest and must still name that day: every reader that takes "the latest event" (the visit
    -- save's Still planned test, the plan-vs-actual reads) would otherwise lose the one-day return
    -- and stamp the week's OTHER days off-plan the moment the rep saves his returned day.
    jsonb_build_object('items', v_count, 'days', to_jsonb(v_days))
      || case
           when v_plan.status = 'returned' and v_plan.returned_day is not null
             then jsonb_build_object('returned_day', v_plan.returned_day)
           else '{}'::jsonb
         end
  );

  return jsonb_build_object('plan_id', v_plan.id, 'status', v_plan.status, 'version', v_plan.version, 'item_count', v_count);
end;
$$;

revoke execute on function public.phoenix_crm_save_plan(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_plan(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;

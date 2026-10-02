-- phoenix_crm_saved_event_keeps_the_returned_day
--
-- WHAT THIS CHANGES: phoenix_crm_save_plan's 'saved' event now carries the week's returned_day in its
--   details while the week stands returned for ONE day. One expression changes; the rest of the body is
--   20260922180258_phoenix_crm_pending_customers.sql's, copied verbatim (live md5 f1c90d17420298a0e6b073af3d2562b8
--   on production and staging before this file).
-- WHY: the owner's "Still planned" ruling (2026-10-02): a week returned for ONE day stays authority on
--   its other days until the rep sends it again. phoenix_crm_save_visit (20261002125244) reads that from
--   the LATEST event with a to_status — and a plan save writes a 'saved' event with to_status 'returned'
--   and no returned_day. So the moment the rep saved his returned day, every visit on the week's OTHER
--   days would be stamped off-plan. Found 2026-10-02 before any plan was returned on production (0
--   returned plans, 0 one-day return events), so no visit was ever stamped wrongly. The screens' reader
--   (src/lib/phoenix-crm/server/plan-day-status.ts loadReturnedFrom) is fixed beside this file: it now
--   reads the 'returned' EVENT, never a save.
-- ROLLBACK: re-run the phoenix_crm_save_plan block of 20260922180258_phoenix_crm_pending_customers.sql.
--   The extra key in old events' details is harmless to every reader.
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
    from jsonb_to_recordset(v_items) as x (customer_id uuid, list_type text)
    where not exists (
      select 1
      from public.phoenix_crm_customers c
      where c.id = x.customer_id
        and c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending')
        and c.list_type = x.list_type
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

  insert into public.phoenix_crm_plan_items (
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
        updated_at = now();

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

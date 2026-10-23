-- phoenix_crm_admin_delete_month_and_manager_visit
--
-- WHAT THIS CHANGES (owner, 2026-10-23, after the first four kinds shipped: "add admin delete to monthly
-- plans, manager visits and double-visit plans"):
--   1. phoenix_crm_admin_deletions.kind admits two more kinds: monthly_plan and manager_visit.
--   2. phoenix_crm_admin_delete(p jsonb) is replaced, the four existing kinds UNCHANGED, with:
--        monthly_plan   a seat's month header and its history, AND every weekly rep plan of that seat whose
--                       Saturday falls in the month (a field-week belongs to the month its Saturday is in).
--                       Each week goes through the same function, so it keeps its own copy and clears its
--                       own children; the month's copy holds the header, its events and the week ids.
--        manager_visit  a district manager's own single visit (phoenix_crm_manager_visits). Nothing hangs
--                       off it: no table has a foreign key to it.
--
-- NOT BUILT, ON PURPOSE: the old double-visit planner (phoenix_crm_double_visit_plans). It was REPLACED on
--   2026-10-16 by the district manager's weekly plan; its screen is deleted and its route answers 410, so no
--   screen draws a row to delete. Its successor, the manager plan's "with a rep" half-days, is already
--   deleted by the manager_plan kind.
--
-- WHO MAY CALL IT: the service role only, exactly as before. The TypeScript service admits the Super Admin
--   alone (canEnterMissedRecords).
--
-- WHAT IT DOES NOT TOUCH: Storage files, and the first days a month opens with that belong to the previous
--   month's last week (that week is the previous month's, not this one's).
--
-- ROLLBACK: restore the previous body of the function from 20261023223001_phoenix_crm_admin_delete_anything.sql
--   and the four-kind check below. The log table stays: it is the only copy of what was deleted. A deleted
--   record is put back from its row there (jsonb_populate_record the `record` into its table, then each array
--   under `children` into its own; for a month, each week_plan_ids entry has its own rep_plan row).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration deletes nothing by itself: it only teaches the function two more kinds.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_admin_deletions drop constraint if exists phoenix_crm_admin_deletions_kind_check;
alter table public.phoenix_crm_admin_deletions
  add constraint phoenix_crm_admin_deletions_kind_check
  check (kind in ('rep_plan', 'manager_plan', 'visit', 'day_activity', 'monthly_plan', 'manager_visit'));

create or replace function public.phoenix_crm_admin_delete(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_seat text;
  v_record jsonb;
  v_children jsonb := '{}'::jsonb;
  v_ids uuid[];
  v_request_ids uuid[];
  v_week uuid;
  v_week_result jsonb;
  v_weeks jsonb := '[]'::jsonb;
begin
  if v_kind is null or v_id is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  if v_kind = 'rep_plan' then
    select to_jsonb(x), x.seat_id into v_record, v_seat
    from public.phoenix_crm_plans x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:plan_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

    select coalesce(array_agg(r.id), '{}') into v_request_ids
    from public.phoenix_crm_plan_edit_requests r where r.plan_id = v_id;

    v_children := jsonb_build_object(
      'items', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_items t where t.plan_id = v_id),
      'activities', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_activities t where t.plan_id = v_id),
      'day_starts', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_day_starts t where t.plan_id = v_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_events t where t.plan_id = v_id),
      'edit_requests', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_edit_requests t where t.plan_id = v_id),
      'edit_request_events', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_plan_edit_request_events t where t.request_id = any (v_request_ids)),
      'team_start_notices', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_team_start_notices t where t.plan_id = v_id)
    );
    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);

    delete from public.phoenix_crm_plan_edit_request_events where request_id = any (v_request_ids);
    delete from public.phoenix_crm_plan_edit_requests where plan_id = v_id;
    delete from public.phoenix_crm_plan_items where plan_id = v_id;
    delete from public.phoenix_crm_plan_activities where plan_id = v_id;
    delete from public.phoenix_crm_plan_day_starts where plan_id = v_id;
    delete from public.phoenix_crm_plan_events where plan_id = v_id;
    delete from public.phoenix_crm_team_start_notices where plan_id = v_id;
    delete from public.phoenix_crm_plans where id = v_id;

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'week_start', v_record ->> 'week_start',
      'edit_request_ids', to_jsonb(v_request_ids));

  elsif v_kind = 'manager_plan' then
    select to_jsonb(x), x.manager_seat_id into v_record, v_seat
    from public.phoenix_crm_manager_plans x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:plan_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || coalesce(v_seat, '')));

    select coalesce(array_agg(r.id), '{}') into v_request_ids
    from public.phoenix_crm_manager_plan_edit_requests r where r.plan_id = v_id;

    v_children := jsonb_build_object(
      'slots', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_manager_plan_slots t where t.plan_id = v_id),
      'slot_customers', (
        select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
        from public.phoenix_crm_manager_plan_customers c
        join public.phoenix_crm_manager_plan_slots s on s.id = c.slot_id
        where s.plan_id = v_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_manager_plan_events t where t.plan_id = v_id),
      'edit_requests', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_manager_plan_edit_requests t where t.plan_id = v_id)
    );
    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);

    -- The slots, their customers, the events and the edit requests cascade from the plan; a manager's visit
    -- that was made against a slot keeps its row and loses only the link (ON DELETE SET NULL).
    delete from public.phoenix_crm_manager_plans where id = v_id;

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'week_start', v_record ->> 'week_start',
      'edit_request_ids', to_jsonb(v_request_ids));

  elsif v_kind = 'visit' then
    select to_jsonb(x), x.seat_id into v_record, v_seat
    from public.phoenix_crm_visits x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:visit_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

    -- The visit and any visit linked from it: that foreign key cascades, so they go together or not at all.
    with recursive family as (
      select v.id from public.phoenix_crm_visits v where v.id = v_id
      union
      select l.id from public.phoenix_crm_visits l join family f on l.linked_from_visit_id = f.id
    )
    select array_agg(f.id) into v_ids from family f;

    v_children := jsonb_build_object(
      'linked_visits', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_visits t where t.id = any (v_ids) and t.id <> v_id),
      'unplanned', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_unplanned_visits t where t.visit_id = any (v_ids)),
      'unplanned_events', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_unplanned_visit_events t where t.visit_id = any (v_ids)),
      'edits', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_visit_edits t where t.visit_id = any (v_ids)),
      'capture_provenance', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_visit_capture_provenance t where t.visit_id = any (v_ids)),
      'recordings', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_visit_recordings t where t.visit_id = any (v_ids)),
      'unlinked_asks', (select coalesce(jsonb_agg(t.id), '[]'::jsonb) from public.phoenix_crm_visit_asks t where t.visit_id = any (v_ids)),
      'unlinked_double_requests', (select coalesce(jsonb_agg(t.id), '[]'::jsonb) from public.phoenix_crm_double_visit_requests t where t.visit_id = any (v_ids))
    );
    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);

    update public.phoenix_crm_visit_asks set visit_id = null where visit_id = any (v_ids);
    update public.phoenix_crm_double_visit_requests set visit_id = null where visit_id = any (v_ids);
    delete from public.phoenix_crm_unplanned_visit_events where visit_id = any (v_ids);
    delete from public.phoenix_crm_unplanned_visits where visit_id = any (v_ids);
    delete from public.phoenix_crm_visit_edits where visit_id = any (v_ids);
    delete from public.phoenix_crm_visit_capture_provenance where visit_id = any (v_ids);
    delete from public.phoenix_crm_visit_recordings where visit_id = any (v_ids);
    delete from public.phoenix_crm_visits where id = any (v_ids);

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'visit_ids', to_jsonb(v_ids),
      'visit_date', v_record ->> 'visit_date');

  elsif v_kind = 'day_activity' then
    select to_jsonb(x), x.seat_id into v_record, v_seat
    from public.phoenix_crm_day_activities x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:activity_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);
    delete from public.phoenix_crm_day_activities where id = v_id;

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'activity_date', v_record ->> 'activity_date');

  elsif v_kind = 'monthly_plan' then
    select to_jsonb(x), x.seat_id into v_record, v_seat
    from public.phoenix_crm_monthly_plans x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:plan_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

    -- The month's weeks: a field-week belongs to the month its Saturday (its week_start) falls in.
    select coalesce(array_agg(pl.id order by pl.week_start), '{}') into v_ids
    from public.phoenix_crm_plans pl
    where pl.seat_id = v_seat
      and pl.is_test = v_is_test
      and pl.week_start >= (v_record ->> 'month_start')::date
      and pl.week_start < ((v_record ->> 'month_start')::date + interval '1 month')::date;

    v_children := jsonb_build_object(
      'events', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.phoenix_crm_monthly_plan_events t where t.monthly_plan_id = v_id),
      'week_plan_ids', to_jsonb(v_ids)
    );
    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);

    -- Each week goes through the very same deletion, so it keeps its own copy of itself and its children.
    foreach v_week in array v_ids loop
      v_week_result := public.phoenix_crm_admin_delete(
        jsonb_build_object('kind', 'rep_plan', 'id', v_week, 'actor_hr_id', v_actor, 'is_test', v_is_test));
      v_weeks := v_weeks || jsonb_build_array(
        jsonb_build_object('id', v_week, 'edit_request_ids', coalesce(v_week_result -> 'edit_request_ids', '[]'::jsonb)));
    end loop;

    delete from public.phoenix_crm_monthly_plan_events where monthly_plan_id = v_id;
    delete from public.phoenix_crm_monthly_plans where id = v_id;

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'month_start', v_record ->> 'month_start',
      'weeks', v_weeks);

  elsif v_kind = 'manager_visit' then
    select to_jsonb(x), x.manager_seat_id into v_record, v_seat
    from public.phoenix_crm_manager_visits x where x.id = v_id and x.is_test = v_is_test for update;
    if v_record is null then raise exception 'phoenix_crm:visit_not_found'; end if;
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || coalesce(v_seat, '')));

    -- Nothing hangs off a manager's own visit: it is a row on its own.
    insert into public.phoenix_crm_admin_deletions (kind, subject_id, seat_id, deleted_by_hr_id, is_test, record, children)
    values (v_kind, v_id, v_seat, v_actor, v_is_test, v_record, v_children);
    delete from public.phoenix_crm_manager_visits where id = v_id;

    return jsonb_build_object('deleted', true, 'kind', v_kind, 'id', v_id, 'visit_date', v_record ->> 'visit_date');
  end if;

  raise exception 'phoenix_crm:bad_input';
end;
$$;

revoke execute on function public.phoenix_crm_admin_delete(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_delete(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;

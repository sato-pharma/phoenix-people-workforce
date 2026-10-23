-- phoenix_crm_admin_delete_anything
--
-- WHAT THIS CHANGES (owner, 2026-10-23: "in every weekly plan, every visit, every record, for the admin only,
-- make admin tools — delete this record or this plan as if it did not happen"):
--   1. phoenix_crm_admin_deletions: one row per thing the Super Admin deleted — what it was, who deleted it
--      and when, and every row exactly as it stood (the record and everything that hung off it).
--      Production has no point-in-time recovery, so a deletion keeps its own copy.
--   2. phoenix_crm_admin_delete(p jsonb): deletes ONE of four kinds, and everything that hangs off it, in
--      one transaction, after the copy is written:
--        rep_plan      a rep's weekly plan: its items, activities, day starts, events, edit requests and
--                      their events, and the team-start notices that named it
--        manager_plan  a manager's weekly plan: its slots, slot customers, events and edit requests
--                      (the manager's visits stay: they are separate records, merely un-linked from a slot)
--        visit         a rep's visit of any kind, whoever entered it, plus a visit linked from it, the
--                      off-plan approval and its events, the correction history, the capture provenance
--                      and the recording rows; a visit ask or double-visit request that pointed at it is
--                      KEPT and un-linked
--        day_activity  a day activity (the "how the day was spent" record)
--
-- WHY: before this the only way to take a record back was hand SQL on production, and the one in-app removal
--   (phoenix_crm_admin_remove_visit) takes back only a visit the Super Admin entered himself.
--
-- WHO MAY CALL IT: the service role only. The TypeScript service admits the Super Admin alone
--   (canEnterMissedRecords); the function re-checks the row against the seat and test flag it was given.
--
-- WHAT IT DOES NOT TOUCH: files in Storage (a recording, a photo, a voice note stay where they are — the copy
--   holds their paths). The rep_entry_days cache follows the row deletes through its own triggers.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_admin_delete(jsonb);
--   The log table stays: it is the only copy of what was deleted. A deleted record is put back from its row
--   here: jsonb_populate_record the `record` into its table, then each array under `children` into its own.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. What was deleted, kept ────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_admin_deletions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rep_plan', 'manager_plan', 'visit', 'day_activity')),
  subject_id uuid not null,
  seat_id text,
  deleted_by_hr_id text not null,
  deleted_at timestamptz not null default now(),
  is_test boolean not null default false,
  -- The row exactly as it stood, and each table that hung off it. Nothing reads these to count anything.
  record jsonb not null,
  children jsonb not null default '{}'::jsonb
);

comment on table public.phoenix_crm_admin_deletions is
  'A plan, visit or day record the Super Admin deleted as if it never happened (owner, 2026-10-23), with the row and everything that hung off it as they stood. Production has no point-in-time recovery, so a deletion keeps its own copy.';

create index if not exists phoenix_crm_admin_deletions_subject_idx
  on public.phoenix_crm_admin_deletions (kind, subject_id);
create index if not exists phoenix_crm_admin_deletions_when_idx
  on public.phoenix_crm_admin_deletions (deleted_at desc);

alter table public.phoenix_crm_admin_deletions enable row level security;
drop policy if exists phoenix_crm_admin_deletions_service_role on public.phoenix_crm_admin_deletions;
create policy phoenix_crm_admin_deletions_service_role
  on public.phoenix_crm_admin_deletions for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_admin_deletions from public, anon, authenticated;
grant all on table public.phoenix_crm_admin_deletions to service_role;

-- ── 2. The deletion ──────────────────────────────────────────────────────────────────────────────

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
  end if;

  raise exception 'phoenix_crm:bad_input';
end;
$$;

revoke execute on function public.phoenix_crm_admin_delete(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_delete(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;

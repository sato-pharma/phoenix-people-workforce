-- phoenix_crm_admin_remove_visit
--
-- WHAT THIS CHANGES (owner, 2026-10-01: "add a way to remove a missed visit I entered by mistake"):
--   1. phoenix_crm_removed_visits: one row per visit the Super Admin removed — who removed it and when,
--      and the rows exactly as they stood: the visit, its off-plan approval and that approval's events.
--      Production has no point-in-time recovery, so a removal keeps its own copy of what it took away.
--   2. phoenix_crm_admin_remove_visit(p jsonb): removes ONE visit the Super Admin ENTERED for a rep
--      (capture_source = 'admin', from phoenix_crm_admin_enter_visit), and only the one who entered it
--      can remove it. A rep's own visit is never removed here: "the rep is responsible for all his
--      records" — only the Super Admin's own mistake is his to take back. The approval rows go with it
--      (events, then the approval, then the visit: neither foreign key cascades), after the copy.
--
-- WHY: a visit entered on the wrong customer or the wrong day is real data on a real rep's record,
--   and before this the only way to take it back was hand SQL on production.
--
-- WHO MAY CALL IT: the service role only (revoked from public, anon and authenticated below). The
--   TypeScript service admits the Super Admin alone — territoryForMissedRecordRemoval in
--   src/lib/phoenix-crm/server/access.ts — and the function re-checks the visit's own source and author.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_admin_remove_visit(jsonb);
--   The log table stays: it is the only copy of what was removed, so it goes only once nobody wants
--   those rows. A REMOVED visit is put back from its row here: insert the `visit` jsonb into
--   phoenix_crm_visits (jsonb_populate_record), then `unplanned` and each of `unplanned_events`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. What was removed, kept ────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_removed_visits (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null,
  seat_id text not null,
  customer_id uuid,
  visit_date date not null,
  rep_hr_id text,
  entered_by_hr_id text not null,
  removed_by_hr_id text not null,
  removed_at timestamptz not null default now(),
  is_test boolean not null default false,
  -- The rows exactly as they stood when removed. Nothing reads these to count anything: they are the
  -- copy that lets a removal be undone by hand, and the record of what it was.
  visit jsonb not null,
  unplanned jsonb,
  unplanned_events jsonb not null default '[]'::jsonb,
  constraint phoenix_crm_removed_visits_one unique (visit_id)
);

comment on table public.phoenix_crm_removed_visits is
  'A visit the Super Admin entered for a rep and then removed as a mistake (owner, 2026-10-01), with the visit, its off-plan approval and that approval''s events as they stood. Production has no point-in-time recovery, so a removal keeps its own copy.';

create index if not exists phoenix_crm_removed_visits_seat_idx
  on public.phoenix_crm_removed_visits (seat_id, visit_date desc);

-- The same four statements, in the same order, as every other table in this module; the
-- `drop policy if exists` keeps the file replayable.
alter table public.phoenix_crm_removed_visits enable row level security;
drop policy if exists phoenix_crm_removed_visits_service_role on public.phoenix_crm_removed_visits;
create policy phoenix_crm_removed_visits_service_role
  on public.phoenix_crm_removed_visits for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_removed_visits from public, anon, authenticated;
grant all on table public.phoenix_crm_removed_visits to service_role;

-- ── 2. Removing a visit the Super Admin entered by mistake ────────────────────────────────────────

create or replace function public.phoenix_crm_admin_remove_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_visit public.phoenix_crm_visits%rowtype;
  v_unplanned jsonb;
  v_events jsonb;
begin
  if v_id is null or v_seat is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_visit
  from public.phoenix_crm_visits v
  where v.id = v_id
    and v.seat_id = v_seat
    and v.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;

  -- Only a visit the Super Admin ENTERED for a rep, and only by the one who entered it. A rep's own
  -- visit is his record and is never removed here, whoever asks.
  if v_visit.capture_source <> 'admin' or v_visit.entered_by_hr_id is distinct from v_actor then
    raise exception 'phoenix_crm:not_entered_by_you';
  end if;

  select to_jsonb(u) into v_unplanned
  from public.phoenix_crm_unplanned_visits u
  where u.visit_id = v_id;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.id), '[]'::jsonb) into v_events
  from public.phoenix_crm_unplanned_visit_events e
  where e.visit_id = v_id;

  -- The copy first, so nothing is deleted that is not already kept.
  insert into public.phoenix_crm_removed_visits (
    visit_id, seat_id, customer_id, visit_date, rep_hr_id, entered_by_hr_id, removed_by_hr_id, is_test,
    visit, unplanned, unplanned_events
  )
  values (
    v_visit.id, v_visit.seat_id, v_visit.customer_id, v_visit.visit_date, v_visit.rep_hr_id, v_visit.entered_by_hr_id,
    v_actor, v_visit.is_test, to_jsonb(v_visit), v_unplanned, v_events
  );

  -- Then the rows, children first: neither foreign key cascades.
  delete from public.phoenix_crm_unplanned_visit_events where visit_id = v_id;
  delete from public.phoenix_crm_unplanned_visits where visit_id = v_id;
  delete from public.phoenix_crm_visits where id = v_id;

  return jsonb_build_object(
    'removed', true,
    'visit_id', v_id,
    'visit_date', v_visit.visit_date,
    'customer_id', v_visit.customer_id,
    'was_unplanned', v_visit.is_unplanned
  );
end;
$$;

revoke execute on function public.phoenix_crm_admin_remove_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_remove_visit(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;

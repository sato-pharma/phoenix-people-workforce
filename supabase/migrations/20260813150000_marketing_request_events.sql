-- ─────────────────────────────────────────────────────────────────────────────
-- marketing_request_events — the history the module has never had.
--
-- WHY THIS EXISTS
--
-- `pg_trigger` on every marketing table returns zero rows, and there is no events, history,
-- activity or comments table anywhere in the schema. Status changes overwrite in place. The
-- consequences are not cosmetic:
--
--   * On 2026-08-09, 1,441 rows were deleted across four marketing tables and the database
--     recorded NOTHING. Reconstructing it needed five independent sources — pg_stat_user_tables,
--     autovacuum timestamps, the ROI refresh log, a JSON snapshot on a laptop, and a PR body — and
--     even then could not distinguish deliberate cleanup from an accident. Only the owner could.
--   * A reject NULLs `returned_at`, so a request that was returned, resubmitted, then refused
--     retains no evidence the return ever happened.
--   * A second advisory comment overwrites the first: one nullable `decision_note` per rung, no
--     append path.
--
-- The standing acceptance bar is that someone can reconstruct what happened to a request six
-- months later without asking anybody. Today that is not merely unmet, it is impossible — the
-- events were never recorded. This table records them.
--
-- ── THE TWO DESIGN DECISIONS WORTH ARGUING WITH ──────────────────────────────
--
-- 1. `request_id` carries NO FOREIGN KEY. That is deliberate and is the entire point.
--    Every child of marketing_requests today is ON DELETE CASCADE, so deleting one request
--    silently destroys its products, targets, approval history and finance record. An audit row
--    that dies with the thing it describes cannot testify about the deletion — which is exactly
--    the gap that made 2026-08-09 unexplainable. These rows outlive their request on purpose, and
--    an "orphan" event here is a feature, not drift. `request_code` is denormalised for the same
--    reason: after the request row is gone, the id alone identifies nothing to a human.
--
-- 2. `actor_hr_id` is BEST EFFORT and nullable. A trigger cannot see the application user; it can
--    only read what the row itself carries (`updated_by_hr_id`, `decision_by_hr_id`). NULL here
--    means "not recorded" and must never be rendered as "system" — the whole file exists because
--    absent evidence was being read as benign.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.marketing_request_events (
  id            bigint generated always as identity primary key,
  -- No FK, on purpose. See note 1 above.
  request_id    uuid        not null,
  request_code  text,
  kind          text        not null,
  -- Nullable and best-effort. See note 2 above.
  actor_hr_id   text,
  -- When the thing HAPPENED (the row's own stamp). For backfilled rows this is historical.
  occurred_at   timestamptz not null default now(),
  -- When this row was WRITTEN. Differs from occurred_at only for the backfill.
  recorded_at   timestamptz not null default now(),
  from_status   text,
  to_status     text,
  step_sequence integer,
  step_name     text,
  note          text,
  payload       jsonb       not null default '{}'::jsonb,
  constraint marketing_request_events_kind_check check (kind = any (array[
    'request_created'::text,
    'request_submitted'::text,
    'request_status_changed'::text,
    'request_value_changed'::text,
    'request_deleted'::text,
    'step_opened'::text,
    'step_decided'::text,
    'step_commented'::text
  ]))
);

comment on table public.marketing_request_events is
  'Append-only history of every marketing request. request_id deliberately carries no FK so events outlive a deleted request; actor_hr_id is best-effort and NULL means "not recorded", never "system".';

create index if not exists marketing_request_events_request_idx
  on public.marketing_request_events (request_id, occurred_at);
create index if not exists marketing_request_events_occurred_idx
  on public.marketing_request_events (occurred_at desc);
create index if not exists marketing_request_events_kind_idx
  on public.marketing_request_events (kind);

-- ── append-only enforcement ──────────────────────────────────────────────────
-- Grants alone are not enough: service_role is the only writer and would otherwise be free to
-- rewrite history. A row, once written, is final.

create or replace function public.phx_marketing_request_events_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'marketing_request_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.phx_marketing_request_events_immutable() from public, anon, authenticated;
grant execute on function public.phx_marketing_request_events_immutable() to service_role;

drop trigger if exists marketing_request_events_immutable on public.marketing_request_events;
create trigger marketing_request_events_immutable
  before update or delete on public.marketing_request_events
  for each row execute function public.phx_marketing_request_events_immutable();

-- TRUNCATE needs its own STATEMENT-level trigger, and this is not belt-and-braces — without it
-- "append-only" is simply untrue. Proven on staging: with UPDATE and DELETE correctly refused,
-- `truncate table marketing_request_events` still succeeded and emptied the table. Two reasons it
-- got through, and the revoke above fixes neither:
--   * TRUNCATE fires no ROW triggers, so the guard above never ran;
--   * revoking TRUNCATE from service_role does nothing to the table OWNER, whose privileges
--     cannot be revoked — and migrations run as the owner.
-- A statement-level BEFORE TRUNCATE trigger does fire for the owner.
--
-- A superuser can still `ALTER TABLE ... DISABLE TRIGGER`; nothing in the database can stop that.
-- What this removes is the accidental and the casual wipe, which is what took 1,441 rows on
-- 2026-08-09 with no record.
drop trigger if exists marketing_request_events_no_truncate on public.marketing_request_events;
create trigger marketing_request_events_no_truncate
  before truncate on public.marketing_request_events
  for each statement execute function public.phx_marketing_request_events_immutable();

-- ── capture: marketing_requests ──────────────────────────────────────────────

create or replace function public.phx_capture_marketing_request_event()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.marketing_request_events
      (request_id, request_code, kind, actor_hr_id, occurred_at, to_status, payload)
    values
      (new.id, new.request_code, 'request_created',
       coalesce(new.created_by_hr_id, new.requester_hr_id), new.created_at, new.status,
       jsonb_build_object('estimated_cost', new.estimated_cost, 'origin', new.origin));
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- The whole row is kept. This is the tombstone that did not exist on 2026-08-09, and it is
    -- the only reason a future bulk delete will be explainable rather than reconstructed.
    insert into public.marketing_request_events
      (request_id, request_code, kind, actor_hr_id, occurred_at, from_status, payload)
    values
      (old.id, old.request_code, 'request_deleted', old.updated_by_hr_id, now(), old.status,
       jsonb_build_object('deleted_row', to_jsonb(old)));
    return old;
  end if;

  if new.status is distinct from old.status then
    insert into public.marketing_request_events
      (request_id, request_code, kind, actor_hr_id, occurred_at, from_status, to_status)
    values
      (new.id, new.request_code,
       case
         when old.status = 'draft' and new.status = 'pending_approval' then 'request_submitted'
         else 'request_status_changed'
       end,
       new.updated_by_hr_id, coalesce(new.updated_at, now()), old.status, new.status);
  end if;

  -- Money moving after submission is a fact about the decision. `estimated_cost` is mutable with
  -- no version and no re-approval trigger, so without this the change leaves no trace at all.
  if new.estimated_cost is distinct from old.estimated_cost then
    insert into public.marketing_request_events
      (request_id, request_code, kind, actor_hr_id, occurred_at, payload)
    values
      (new.id, new.request_code, 'request_value_changed', new.updated_by_hr_id,
       coalesce(new.updated_at, now()),
       jsonb_build_object('from', old.estimated_cost, 'to', new.estimated_cost));
  end if;

  return new;
end;
$$;

revoke execute on function public.phx_capture_marketing_request_event() from public, anon, authenticated;
grant execute on function public.phx_capture_marketing_request_event() to service_role;

drop trigger if exists marketing_requests_capture_event on public.marketing_requests;
create trigger marketing_requests_capture_event
  after insert or update or delete on public.marketing_requests
  for each row execute function public.phx_capture_marketing_request_event();

-- ── capture: marketing_request_approval_steps ────────────────────────────────

create or replace function public.phx_capture_marketing_step_event()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_code text;
  v_kind         text;
begin
  if tg_op = 'INSERT' then
    -- The chain is materialised all at once at submit: one rung 'current', the rest 'pending'.
    -- Recording the pending ones would write four rows saying nothing happened. Only the rung that
    -- actually opened is an event.
    if new.status <> 'current' then
      return new;
    end if;
    v_kind := 'step_opened';
  else
    if new.status is distinct from old.status then
      v_kind := case when new.status = 'current' then 'step_opened' else 'step_decided' end;
    elsif new.decision_note is distinct from old.decision_note then
      -- postMarketingAdvisoryComment OVERWRITES decision_note on a CC rung, so a reviewer's second
      -- comment destroys their first. The column is still overwritten — fixing that is separate —
      -- but from here on every comment survives as its own event.
      v_kind := 'step_commented';
    else
      return new;
    end if;
  end if;

  select r.request_code into v_request_code
  from public.marketing_requests r
  where r.id = new.request_id;

  insert into public.marketing_request_events
    (request_id, request_code, kind, actor_hr_id, occurred_at,
     from_status, to_status, step_sequence, step_name, note, payload)
  values
    (new.request_id, v_request_code, v_kind,
     coalesce(new.decision_by_hr_id, new.assigned_hr_id),
     coalesce(new.decision_at, new.updated_at, now()),
     case when tg_op = 'UPDATE' then old.status else null end,
     new.status, new.sequence, new.step_name, new.decision_note,
     jsonb_build_object('step_code', new.step_code, 'is_cc', new.is_cc));

  return new;
end;
$$;

revoke execute on function public.phx_capture_marketing_step_event() from public, anon, authenticated;
grant execute on function public.phx_capture_marketing_step_event() to service_role;

drop trigger if exists marketing_request_steps_capture_event on public.marketing_request_approval_steps;
create trigger marketing_request_steps_capture_event
  after insert or update on public.marketing_request_approval_steps
  for each row execute function public.phx_capture_marketing_step_event();

-- ── access ───────────────────────────────────────────────────────────────────
-- Same posture as the module's twelve other workflow tables: RLS on with no policies, which is
-- deny-all for anon/authenticated, and every read goes through the service-role client.
-- Deliberately NO update/delete grant, even for service_role — the trigger above refuses anyway,
-- and the grant should say the same thing.
-- Revoked from the two named roles, never from PUBLIC: revoking PUBLIC on a default ACL also
-- strips service_role in this database.

alter table public.marketing_request_events enable row level security;
revoke all on table public.marketing_request_events from anon, authenticated;

-- service_role is granted ALL on every new table in `public` by Supabase's default ACL, so a bare
-- `grant select, insert` here adds nothing and restricts nothing — verified on staging, where the
-- table came up with DELETE/UPDATE/TRUNCATE already held. The privileges have to be taken away
-- explicitly.
--
-- TRUNCATE matters most and is the reason this is not merely tidiness: TRUNCATE does not fire row
-- triggers, so the append-only trigger above would not see it. Left granted, "append-only" would
-- be a claim the database does not actually enforce.
revoke update, delete, truncate on table public.marketing_request_events from service_role;
grant select, insert on table public.marketing_request_events to service_role;

-- ── backfill ─────────────────────────────────────────────────────────────────
-- Every backfilled row carries payload->>'backfilled' = 'true' and a recorded_at of now(), so a
-- derived event can never be mistaken for one captured live. Derived from timestamps that already
-- exist; nothing is invented. Idempotent — re-running adds nothing.

insert into public.marketing_request_events
  (request_id, request_code, kind, actor_hr_id, occurred_at, to_status, payload)
select r.id, r.request_code, 'request_created',
       coalesce(r.created_by_hr_id, r.requester_hr_id), r.created_at, 'draft',
       jsonb_build_object('backfilled', true, 'estimated_cost', r.estimated_cost, 'origin', r.origin)
from public.marketing_requests r
where not exists (
  select 1 from public.marketing_request_events e
  where e.request_id = r.id and e.kind = 'request_created'
);

insert into public.marketing_request_events
  (request_id, request_code, kind, actor_hr_id, occurred_at, from_status, to_status, payload)
select r.id, r.request_code, 'request_submitted', r.requester_hr_id, r.submitted_at,
       'draft', 'pending_approval', jsonb_build_object('backfilled', true)
from public.marketing_requests r
where r.submitted_at is not null
  and not exists (
    select 1 from public.marketing_request_events e
    where e.request_id = r.id and e.kind = 'request_submitted'
  );

insert into public.marketing_request_events
  (request_id, request_code, kind, actor_hr_id, occurred_at,
   from_status, to_status, step_sequence, step_name, note, payload)
select s.request_id, r.request_code, 'step_decided',
       coalesce(s.decision_by_hr_id, s.assigned_hr_id), s.decision_at,
       'current', s.status, s.sequence, s.step_name, s.decision_note,
       jsonb_build_object('backfilled', true, 'step_code', s.step_code, 'is_cc', s.is_cc)
from public.marketing_request_approval_steps s
join public.marketing_requests r on r.id = s.request_id
where s.decision_at is not null
  and s.status in ('approved', 'rejected', 'returned')
  and not exists (
    select 1 from public.marketing_request_events e
    where e.request_id = s.request_id
      and e.kind = 'step_decided'
      and e.step_sequence = s.sequence
  );

-- The terminal stamp, whichever one this request carries. `executed_at` is included because a
-- finance execution is the only path to `active`.
insert into public.marketing_request_events
  (request_id, request_code, kind, actor_hr_id, occurred_at, from_status, to_status, payload)
select r.id, r.request_code, 'request_status_changed', r.updated_by_hr_id,
       coalesce(r.executed_at, r.approved_at, r.rejected_at, r.returned_at),
       'pending_approval', r.status, jsonb_build_object('backfilled', true)
from public.marketing_requests r
where coalesce(r.executed_at, r.approved_at, r.rejected_at, r.returned_at) is not null
  and r.status <> 'draft'
  and not exists (
    select 1 from public.marketing_request_events e
    where e.request_id = r.id and e.kind = 'request_status_changed'
  );

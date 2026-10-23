-- repair_stranded_in_app_notifications
--
-- WHAT THIS CHANGES: two classes of in-app delivery that the ledger records as "sent" but that no
-- bell can ever open, found by the in-app-sent-recipient-must-be-able-to-see-it reconciliation check
-- (622 of 31,727 on 2026-10-23, the newest written that day).
--   A. 386 deliveries whose recipient has NO HR ID (377 to the admin-HR service login, 9 to a login
--      of 2026-06). The bell is keyed on an HR ID, so nothing could ever be shown. They are set to
--      status 'skipped' with the reason in last_error and sent_at cleared — the truth, not a loss.
--   B. 236 deliveries on 202 events whose person was overwritten. Every approval rung of a direct
--      order wrote the SAME event_key as a lone-recipient call, so the next rung replaced
--      employee_hr_id / recipients and the previous approver's notice lost its owner. Each such
--      person is added back to that event's recipients, and an already-read, already-archived
--      notification_user_states row is written for them, so a decided rung does not reappear as an
--      unread item in a bell.
--
-- WHY: the check pages the owner every morning once re-armed; the code fixes in the same pull request
-- (a lone recipient keeps its own event key; a recipient with no HR ID is recorded skipped) stop new
-- rows, and this repairs the history so the check starts from zero.
--
-- PRE-IMAGE: notification_backup_20261023 holds the rows exactly as they were, before any change.
--
-- ROLLBACK (data only, nothing is dropped by this file):
--   update public.notification_deliveries d set status = b.status, last_error = b.last_error,
--          sent_at = b.sent_at, updated_at = b.updated_at
--     from notification_backup_20261023.deliveries_no_hr_id b where b.id = d.id;
--   update public.notification_events e set recipients = b.recipients, updated_at = b.updated_at
--     from notification_backup_20261023.events_widened b where b.id = e.id;
--   delete from public.notification_user_states s
--     using notification_backup_20261023.user_states_added b where b.id = s.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Announced to the owner in plain words BEFORE it was applied.
--
-- Idempotent: every statement selects only rows still in the broken state, so a re-run changes nothing.

begin;

create schema if not exists notification_backup_20261023;

create table if not exists notification_backup_20261023.deliveries_no_hr_id
  as select * from public.notification_deliveries where false;
create table if not exists notification_backup_20261023.events_widened
  as select * from public.notification_events where false;
create table if not exists notification_backup_20261023.user_states_added
  as select * from public.notification_user_states where false;

-- ── A. In-app "sent" to a recipient who has no HR ID ──────────────────────────────────────────────
insert into notification_backup_20261023.deliveries_no_hr_id
select d.*
from public.notification_deliveries d
where d.channel = 'in_app'
  and d.status = 'sent'
  and btrim(coalesce(d.recipient_hr_id, '')) = ''
  and not exists (select 1 from notification_backup_20261023.deliveries_no_hr_id b where b.id = d.id);

update public.notification_deliveries d
set status = 'skipped',
    last_error = 'Recipient has no HR ID, and the in-app bell is keyed on one — nothing could be shown.',
    sent_at = null,
    updated_at = now()
where d.channel = 'in_app'
  and d.status = 'sent'
  and btrim(coalesce(d.recipient_hr_id, '')) = '';

-- ── B. In-app "sent" to a person the event no longer names ────────────────────────────────────────
-- "Names" is the bell's own rule (canViewerSeeNotification): the person is the event's employee_hr_id
-- or is in its recipients, ignoring entries that are an email, a PHASE fixture or a FIXTURE marker.
create temporary table _stranded_pairs on commit drop as
select distinct e.id as event_id, upper(btrim(d.recipient_hr_id)) as hr_id, d.recipient_user_id as user_id
from public.notification_deliveries d
join public.notification_events e on e.id = d.notification_event_id
where d.channel = 'in_app'
  and d.status = 'sent'
  and btrim(coalesce(d.recipient_hr_id, '')) <> ''
  and position('@' in d.recipient_hr_id) = 0
  and upper(btrim(d.recipient_hr_id)) not like 'PHASE%'
  and position('FIXTURE' in upper(d.recipient_hr_id)) = 0
  and not (
    (
      e.employee_hr_id is not null
      and upper(btrim(e.employee_hr_id)) = upper(btrim(d.recipient_hr_id))
      and position('@' in e.employee_hr_id) = 0
      and upper(btrim(e.employee_hr_id)) not like 'PHASE%'
      and position('FIXTURE' in upper(e.employee_hr_id)) = 0
    )
    or exists (
      select 1
      from unnest(coalesce(e.recipients, array[]::text[])) r
      where upper(btrim(r)) = upper(btrim(d.recipient_hr_id))
        and position('@' in r) = 0
        and upper(btrim(r)) not like 'PHASE%'
        and position('FIXTURE' in upper(r)) = 0
    )
  );

insert into notification_backup_20261023.events_widened
select e.*
from public.notification_events e
where e.id in (select event_id from _stranded_pairs)
  and not exists (select 1 from notification_backup_20261023.events_widened b where b.id = e.id);

update public.notification_events e
set recipients = (
      select coalesce(array_agg(distinct x order by x), array[]::text[])
      from unnest(coalesce(e.recipients, array[]::text[]) || p.hr_ids) as x
    ),
    updated_at = now()
from (
  select event_id, array_agg(distinct hr_id) as hr_ids
  from _stranded_pairs
  group by event_id
) p
where e.id = p.event_id;

-- A decided rung is history: written as read and archived so no bell shows it as new.
with ins as (
  insert into public.notification_user_states (notification_event_id, user_id, hr_id, read_at, archived_at)
  select p.event_id, p.user_id, p.hr_id, now(), now()
  from _stranded_pairs p
  on conflict (notification_event_id, hr_id) do nothing
  returning *
)
insert into notification_backup_20261023.user_states_added
select * from ins;

commit;

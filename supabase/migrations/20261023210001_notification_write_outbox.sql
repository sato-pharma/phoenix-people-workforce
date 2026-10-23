-- notification_write_outbox
--
-- WHAT THIS CHANGES: adds `public.notification_write_outbox`, where a `notification_events` or
--   `notification_deliveries` row that could not be written is parked with its whole payload until
--   a later attempt lands it. Same shape as `audit_log_outbox` and drained by the same mechanism
--   (`src/lib/platform/write-outbox.ts`).
--
-- WHY: owner, 23 Oct 2026 — "protect the notification writes with the same outbox". On 22 Oct
--   production Postgres restarted FOUR times between 11:30 and 14:25 Cairo (postmaster start moving
--   at 08:30, 08:51, 09:33 and 11:25 UTC, recorded by the `database_restarted` detector), with
--   Cloudflare 520s and 521s at the edge. Everything writing through a short client timeout in
--   those minutes lost what it was writing, and only the audit log had anywhere to put it.
--
--   🔴 THE DELIVERY ROW IS THE DANGEROUS ONE. `upsertDelivery` records that a send SUCCEEDED and
--   swallowed its own failure with a log line. The retry drain re-sends any delivery row still
--   sitting open, so a lost status write did not merely lose bookkeeping — it armed a SECOND real
--   email or Telegram message to a real person on the next drain. Both writes this table carries
--   are upserts on a unique key (`event_key`, `idempotency_key`), so replaying one is harmless.
--
--   No new cron: a scheduled drain needs a cron-job.org slot and a Healthchecks slot, and the
--   project has none left. The queue is drained opportunistically off real notification traffic.
--
--   A SEPARATE TABLE from `audit_log_outbox` on purpose. Merging the two would mean dropping the
--   audit queue, which went live an hour earlier, while the serving build still wrote to it — a
--   window with exactly the behaviour these tables exist to remove. One mechanism, two tables.
--
-- ROLLBACK: drop table public.notification_write_outbox;
--   Safe at any time: it holds only writes not yet in their real table, so dropping it loses
--   whatever is still queued and nothing else. Rolling back the code without the table is also
--   safe — the queue write is wrapped and a failure there falls back to the log line it replaced.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive: one new, empty table.

begin;

create table if not exists public.notification_write_outbox (
  id uuid primary key default gen_random_uuid(),
  -- {kind, eventKey|idempotencyKey, row} — everything a later attempt needs and nothing else.
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  -- Held off until this moment; pushed further out on each failure so one unwritable row cannot
  -- soak up every drain. A fresh entry is due immediately.
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.notification_write_outbox is
  'notification_events / notification_deliveries rows whose write failed (usually a client-side timeout during a database outage). Drained opportunistically by src/lib/notifications/notification-outbox.ts; a row is deleted the moment its real write lands.';

-- The drain's only query, in its own order: rows whose next_attempt_at has passed, oldest first.
create index if not exists notification_write_outbox_due_idx
  on public.notification_write_outbox (next_attempt_at, created_at);

-- Service-role only. RLS on with no policy: a queued row carries a notification's whole payload,
-- including its recipient, and every code path that touches this table uses the service-role client.
alter table public.notification_write_outbox enable row level security;

revoke all on public.notification_write_outbox from anon, authenticated;

commit;

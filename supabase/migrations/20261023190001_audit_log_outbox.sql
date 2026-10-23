-- audit_log_outbox
--
-- WHAT THIS CHANGES: adds `public.audit_log_outbox`, where an `audit_logs` row that could not be
--   written is parked with its whole payload until a later attempt lands it.
--
-- WHY: owner, 23 Oct 2026, choosing "both, plus never lose a row". `insertAuditLog` opens its client
--   with a 3-second request timeout, and under load the insert aborts: 109 `audit_persistence_failed`
--   rows in 21 days, 40 of them on 22 Oct alone. These are not the usual "timed out but committed
--   anyway" case — the notification row logged at 16:19 Cairo on 23 Oct
--   (f67a82b2-fe70-4024-80b4-ca7e3f9a60dc) has no `audit_logs` row at all, while its neighbours
--   written the same minute landed. The trail was simply losing entries.
--
--   No new cron: a new scheduled job needs a cron-job.org slot and a Healthchecks slot, and the
--   project has none left. The queue is drained opportunistically off real audit traffic instead —
--   every successful audit write flushes a few pending rows — which is self-healing and costs
--   nothing at rest. `next_attempt_at` is what keeps a poisoned row from being retried in a loop.
--
-- ROLLBACK: drop table public.audit_log_outbox;
--   Safe at any time: it holds only entries not yet in `audit_logs`, so dropping it loses whatever
--   is still queued and nothing else. Rolling back the code without the table is also safe — the
--   queue write is wrapped and a failure there falls back to the log line it replaced.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive: one new, empty table.

begin;

create table if not exists public.audit_log_outbox (
  id uuid primary key default gen_random_uuid(),
  -- The whole AuditLogInput as it would have been inserted, so a later attempt needs nothing else.
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  -- Held off until this moment; pushed further out on each failure so one unwritable row cannot
  -- soak up every drain. A fresh entry is due immediately.
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.audit_log_outbox is
  'audit_logs rows whose insert failed (usually a client-side request timeout under load). Drained opportunistically by src/lib/admin/audit-outbox.ts on the back of successful audit writes; a row is deleted the moment its audit_logs insert lands.';

-- The drain's only query, in its own order: rows whose next_attempt_at has passed, oldest first.
-- Leading on next_attempt_at is what makes the backed-off rows skippable rather than scanned.
create index if not exists audit_log_outbox_due_idx
  on public.audit_log_outbox (next_attempt_at, created_at);

-- Service-role only, like audit_logs itself. RLS on with no policy: nothing in the browser may read
-- a queued audit row, and every code path that touches this table uses the service-role client.
alter table public.audit_log_outbox enable row level security;

revoke all on public.audit_log_outbox from anon, authenticated;

commit;

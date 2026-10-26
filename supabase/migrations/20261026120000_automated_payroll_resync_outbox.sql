-- automated_payroll_resync_outbox
--
-- WHAT THIS CHANGES: adds `public.automated_payroll_resync_outbox`, where a payroll resync (a
--   Deductions or outstation expense decision clearing the figure a payroll step froze) that could
--   not take the run's hold is parked with its whole target until a later attempt runs it UNDER the
--   hold. Same shape as `audit_log_outbox` and `notification_write_outbox`, drained by the same
--   mechanism (`src/lib/platform/write-outbox.ts`, `src/lib/automated-payroll/resync-outbox.ts`).
--
-- WHY: audit 2026-10-26, P2-02. Until now a resync whose 5-second wait for the run's hold ran out
--   went ahead WITHOUT the hold (`whenWaitRunsOut: "proceed"`), so its clear could land inside a
--   Part confirm — exactly the race the hold was built to close. The wait now refuses, and a refused
--   resync is queued here rather than dropped, because several callers (an outstation request
--   rejected or deleted) ignore the outcome and the queue is what makes the decision reach payroll.
--
--   No new cron: drained opportunistically off the Automated Payroll run page and off every resync
--   that succeeds.
--
-- ROLLBACK: drop table public.automated_payroll_resync_outbox;
--   Safe at any time: it holds only resyncs not yet run, so dropping it loses whatever is still
--   queued and nothing else. Rolling back the code without the table is also safe — the queue write
--   is wrapped and a failure there falls back to the "could not be updated" line it replaced.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive: one new, empty table.

begin;

create table if not exists public.automated_payroll_resync_outbox (
  id uuid primary key default gen_random_uuid(),
  -- {kind: "deduction" | "expense", target} — the whole resync target and nothing else.
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  -- Held off until this moment; pushed further out on each failure so one resync that keeps
  -- failing cannot soak up every drain. A fresh entry is due immediately.
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.automated_payroll_resync_outbox is
  'Payroll resyncs (Deductions / outstation expense decisions) refused by the run''s hold. Drained opportunistically by src/lib/automated-payroll/resync-outbox.ts, always under the hold; a row is deleted once its resync runs or is skipped.';

-- The drain's only query, in its own order: rows whose next_attempt_at has passed, oldest first.
create index if not exists automated_payroll_resync_outbox_due_idx
  on public.automated_payroll_resync_outbox (next_attempt_at, created_at);

-- Service-role only. RLS on with no policy: a queued row names employees by HR id, and every code
-- path that touches this table uses the service-role client.
alter table public.automated_payroll_resync_outbox enable row level security;

revoke all on public.automated_payroll_resync_outbox from public, anon, authenticated;

do $$
begin
  if has_table_privilege('anon', 'public.automated_payroll_resync_outbox', 'select')
     or has_table_privilege('authenticated', 'public.automated_payroll_resync_outbox', 'select') then
    raise exception 'automated_payroll_resync_outbox: a browser role can still read the queue';
  end if;
end $$;

commit;

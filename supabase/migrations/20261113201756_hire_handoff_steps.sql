-- hire_handoff_steps
--
-- WHAT THIS CHANGES:
--   * public.hire_handoff_steps — one row per (new employee, hand-off step): which door made the
--     hire (HR's Add Employee, or the candidate's offer joining form), which follow-up step it is
--     (the offer letter linked, the candidate marked hired, the portal login, the CV, the mailbox
--     task, the offer stamped accepted, the joining form's audit row), whether it is pending, done,
--     failed or given up, how many attempts it has had, the last error as a short sentence, and the
--     ids a retry needs (`context`). Written and read by the server only.
--   * Its key to public.employees(hr_id), ON UPDATE CASCADE so an HR id rename carries the ledger,
--     ON DELETE CASCADE so a ledger row never blocks removing a record made by mistake. The unique
--     (employee_hr_id, step) index leads with the key's column, so it is also the key's index.
--   * A partial index on the rows the hourly reconciler and the Needs You board read (pending,
--     failed, gave_up), oldest first.
--
-- WHY (enterprise audit 2026-11-13, REC-027, "the hire hand-off is complete or self-repairing"):
--   After the employee row is written, both hiring doors run five to seven follow-up steps, and each
--   one only LOGGED its failure (`offer_hire_sync_failed`, `offer_joining_form_stamp_failed`,
--   `offer_joining_form_audit_failed`, `offer_joining_form_access_failed`, ...). Nothing retried a
--   step and nothing showed it: a hire with no login, an offer letter still pointing at nobody, a
--   candidate still "shortlisted" after joining, were found by a person noticing. This ledger makes
--   every step leave a row, the hourly `hire-handoff-reconcile` job retries the failed ones, and the
--   ones that give up reach the Needs You board by the employee's name.
--
-- WHAT IS NEVER STORED: no password, token, salary figure or national id — `context` holds only the
--   ids a retry needs (offer id, candidate or application id, the staged CV's id) and two booleans.
--   The application writes it through a whitelist (src/lib/employees/hire-handoff.ts).
--
-- ROLLBACK (additive; nothing existing is altered):
--   -- SAFE: drops only the ledger this migration created, and only on a deliberate rollback.
--   drop table if exists public.hire_handoff_steps;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it creates one empty table and writes no existing row.

begin;
set local lock_timeout = '5s';

create table if not exists public.hire_handoff_steps (
  id             uuid        primary key default gen_random_uuid(),
  employee_hr_id text        not null
                             references public.employees (hr_id) on update cascade on delete cascade,
  source         text        not null check (source in ('add_employee', 'joining_form')),
  step           text        not null check (step in (
                               'offer_link', 'candidate_hired', 'login', 'cv', 'mailbox_task',
                               'offer_stamp', 'acceptance_audit'
                             )),
  status         text        not null default 'pending'
                             check (status in ('pending', 'done', 'failed', 'gave_up')),
  attempts       integer     not null default 0 check (attempts >= 0),
  last_error     text,
  context        jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint hire_handoff_steps_employee_step_key unique (employee_hr_id, step)
);

comment on table public.hire_handoff_steps is
  'One row per new employee and hand-off step (REC-027). Both hiring doors write it; the hourly '
  'hire-handoff-reconcile job retries failed and stale pending rows and gives up after five attempts; '
  'failed and gave_up rows reach the Needs You board. context holds ids only, never a password, '
  'token, salary or national id. Service role only.';

-- The reconciler's and the board's read: the unfinished rows, oldest first.
create index if not exists hire_handoff_steps_unfinished_idx
  on public.hire_handoff_steps (status, updated_at)
  where status in ('pending', 'failed', 'gave_up');

-- Service role only, like job_leases: row security on, one policy for the service role, no grant to
-- either browser role.
alter table public.hire_handoff_steps enable row level security;
revoke all on public.hire_handoff_steps from public, anon, authenticated;
grant select, insert, update on public.hire_handoff_steps to service_role;

drop policy if exists phx_hire_handoff_steps_service_role on public.hire_handoff_steps;
create policy phx_hire_handoff_steps_service_role
  on public.hire_handoff_steps
  for all
  to service_role
  using (true)
  with check (true);

commit;

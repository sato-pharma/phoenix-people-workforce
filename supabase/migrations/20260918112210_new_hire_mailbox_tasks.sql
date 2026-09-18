-- new_hire_mailbox_tasks
--
-- WHAT THIS CHANGES: adds public.new_hire_mailbox_tasks, one row per newly added employee asking a
-- single question — has this person's Turbify mailbox been created and connected to their My email
-- in Phoenix yet? The audience told when a row opens, `new_hire_mailbox_alert`, is added by
-- 20260918120027_notification_role_policies_new_hire_mailbox_key.sql.
--
-- WHY: owner instruction 2026-09-18. When an employee is added, the company email should be taken
-- care of without the new hire doing anything: Phoenix picks the address, tells the owner, and the
-- app password he creates while activating the mailbox in Turbify is handed straight to Phoenix,
-- so the new hire's My email is connected on day one. Turbify publishes no API that can create a
-- mailbox or an app password (both exist only as buttons in its own screens, confirmed against its
-- help pages the same day), so the Turbify half stays a person's two minutes; everything around it
-- is Phoenix's.
--
-- ROLLBACK:
--   drop table if exists public.new_hire_mailbox_tasks;   -- SAFE: holds no credential; a queue only
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new empty table.

begin;

create table if not exists public.new_hire_mailbox_tasks (
  id                 uuid        primary key default gen_random_uuid(),
  employee_hr_id     text        not null,
  -- HR ids are stored MIXED CASE across this database, so a plain equality lookup silently
  -- under-returns (AGENTS.md §2.1). A task's identity is the folded key, enforced here rather than
  -- by whichever caller remembers to fold both sides.
  employee_hr_id_key text        generated always as (lower(btrim(employee_hr_id))) stored,
  -- The company address to create in Turbify. Phoenix proposes it when the task opens (the
  -- employee's own work email when HR typed one, else first.second@ the company domain); NULL only
  -- when the name holds no Latin letters to build one from, and then the owner types it.
  email_address      text,
  status             text        not null default 'pending',
  source             text        not null default 'manual_add',
  opened_at          timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by_hr_id  text,
  resolution_note    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint new_hire_mailbox_tasks_status_check
    check (status in ('pending', 'connected', 'not_needed')),
  constraint new_hire_mailbox_tasks_source_check
    check (source in ('manual_add', 'employee_import')),
  constraint new_hire_mailbox_tasks_address_shape
    check (email_address is null or (email_address = lower(btrim(email_address)) and email_address like '%_@_%.__%')),
  -- A closed task names who closed it and when. Without this the table could hold a row that reads
  -- "somebody dealt with this" while naming nobody, which is worse than a pending row.
  constraint new_hire_mailbox_tasks_resolution_complete
    check (
      status = 'pending'
      or (resolved_at is not null and btrim(coalesce(resolved_by_hr_id, '')) <> '')
    ),
  -- "Connected" means Turbify accepted an app password for THIS address, so the address is known.
  constraint new_hire_mailbox_tasks_connected_has_address
    check (status <> 'connected' or email_address is not null),
  -- "No mailbox needed" is a decision, and a reason is the whole value of recording it.
  constraint new_hire_mailbox_tasks_not_needed_has_reason
    check (status <> 'not_needed' or btrim(coalesce(resolution_note, '')) <> '')
);

create unique index if not exists new_hire_mailbox_tasks_employee_idx
  on public.new_hire_mailbox_tasks (employee_hr_id_key);

-- Two new hires must never be handed the same mailbox. A task ruled "no mailbox needed" releases its
-- address, because that mailbox was never created.
create unique index if not exists new_hire_mailbox_tasks_address_idx
  on public.new_hire_mailbox_tasks (email_address)
  where email_address is not null and status <> 'not_needed';

create index if not exists new_hire_mailbox_tasks_pending_idx
  on public.new_hire_mailbox_tasks (status, opened_at desc);

comment on table public.new_hire_mailbox_tasks is
  'One row per newly added employee: has their Turbify mailbox been created and connected to their My email in Phoenix, or ruled not needed. Opened by the employee-create paths, cleared on the New Hire Mailboxes page. Holds NO credential: the app password is sealed straight into personal_mailbox_connections, under the new hire''s own login.';

comment on column public.new_hire_mailbox_tasks.employee_hr_id_key is
  'Generated fold of employee_hr_id. The unique index sits on THIS, because HR ids are stored mixed-case — "B-10" and "b-10" are one person and must never open two tasks.';

comment on column public.new_hire_mailbox_tasks.status is
  'pending | connected (Turbify accepted an app password for this address and it is sealed for the new hire) | not_needed (a named person ruled this hire gets no mailbox, with a reason).';

comment on column public.new_hire_mailbox_tasks.resolved_by_hr_id is
  'The HR id of the person who closed this task, taken from their session. NOT employees.updated_by_hr_id, which does not reliably say who wrote a row.';

-- RLS on with no browser grant, the norm for this schema: every reader is the service role, reached
-- through the app's own permission checks.
alter table public.new_hire_mailbox_tasks enable row level security;

revoke all on public.new_hire_mailbox_tasks from public, anon, authenticated;
grant select, insert, update on public.new_hire_mailbox_tasks to service_role;

commit;

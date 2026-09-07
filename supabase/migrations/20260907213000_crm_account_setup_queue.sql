-- A new employee cannot be seen in the CRM until somebody creates his iReports360 account, and
-- nothing in Phoenix has ever said so out loud.
--
-- THE GAP THIS CLOSES. `employees.crm_username` and `employees.crm_id` are how every CRM read
-- resolves a visit, a check-in or a double visit back to a person (src/lib/crm/identity.ts). They
-- are optional columns on the employee form, so a new hire is routinely saved without them — and
-- from that moment his field work is invisible: it lands in the mirror under an unmapped agent id
-- and shows up on the Unmapped Agents punch-list weeks later, if anyone looks. There is no error
-- and no empty state anywhere; the rep simply reads as somebody who did nothing.
--
-- Owner instruction 2026-09-07: when an employee is added to the employee master, the SFE Manager
-- is told — by email AND in-app — with the new person's line, hiring date, region, area, manager,
-- work email and mobile, and following that notification puts him on a screen that asks for the
-- CRM username and the CRM code.
--
-- WHY A TABLE AND NOT A DERIVED LIST. The obvious shape is "every active employee with a blank
-- crm_username", computed on the fly. That is wrong in one specific way: it can never be finished.
-- Most of the company — finance, HR, head office — will never hold a CRM account, so a derived
-- list grows a permanent tail of rows nobody can clear, and a queue that cannot reach zero stops
-- being read. This table gives each new hire exactly one row that ends in one of two terminal
-- states: the account was created, or this person does not need one. Both are decisions somebody
-- made, with a name and a timestamp against them.
--
-- The row is opened for EVERY new employee, deliberately, rather than for a guessed list of
-- field-force job titles. Titles here are free text (docs/agents-owner-rules.md on job_title's two
-- writers), so any such filter would silently miss a rep whose title was typed differently — and a
-- missed rep is invisible field work, while a wrongly-included accountant costs one click.

create table if not exists public.crm_account_setup_tasks (
  id                uuid        primary key default gen_random_uuid(),
  employee_hr_id    text        not null,
  -- HR ids are stored in MIXED CASE across this database, so a plain equality lookup silently
  -- under-returns (AGENTS.md §2.1). The identity of a task is therefore the folded key, enforced
  -- here by the database rather than by whichever caller remembers to fold both sides.
  employee_hr_id_key text generated always as (lower(btrim(employee_hr_id))) stored,
  status            text        not null default 'pending',
  source            text        not null default 'manual_add',
  opened_at         timestamptz not null default now(),
  resolved_at       timestamptz,
  resolved_by_hr_id text,
  resolution_note   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint crm_account_setup_tasks_status_check
    check (status in ('pending', 'completed', 'not_applicable')),
  constraint crm_account_setup_tasks_source_check
    check (source in ('manual_add', 'employee_import')),
  -- A resolved task must say who resolved it and when. Without this the table can hold a row that
  -- reads as "somebody dealt with this" while naming nobody, which is worse than a pending row.
  constraint crm_account_setup_tasks_resolution_complete
    check (
      status = 'pending'
      or (resolved_at is not null and btrim(coalesce(resolved_by_hr_id, '')) <> '')
    )
);

create unique index if not exists crm_account_setup_tasks_employee_idx
  on public.crm_account_setup_tasks (employee_hr_id_key);

create index if not exists crm_account_setup_tasks_pending_idx
  on public.crm_account_setup_tasks (status, opened_at desc);

comment on table public.crm_account_setup_tasks is
  'One row per newly created employee: has somebody given this person an iReports360 (CRM) account, or ruled that they do not need one. Opened by the employee-create paths, cleared on the CRM workspace''s New Hire CRM Setup tab.';

comment on column public.crm_account_setup_tasks.employee_hr_id_key is
  'Generated fold of employee_hr_id. The unique index sits on THIS, not on the raw column, because HR ids are stored mixed-case — "B-10" and "b-10" are one person and must never open two tasks.';

comment on column public.crm_account_setup_tasks.status is
  'pending | completed (the CRM username and code were entered) | not_applicable (this person holds no CRM account). Both non-pending states are decisions a named person made.';

comment on column public.crm_account_setup_tasks.resolved_by_hr_id is
  'The HR id of the person who cleared this task, taken from their session. NOT employees.updated_by_hr_id, which does not reliably say who wrote a row.';

comment on column public.crm_account_setup_tasks.source is
  'Which create path opened this task — a manual add on the employee master, or a confirmed employee import.';

-- This table holds no CRM credentials of its own: the account name and code live on the employees
-- row (crm_username / crm_id), which is what every CRM read resolves against. Duplicating them here
-- would create a second copy free to disagree with the first.

-- RLS on with no `authenticated` grant, which is the norm for this schema: every reader is the
-- service role, reached through the app's own permission checks.
alter table public.crm_account_setup_tasks enable row level security;

revoke all on public.crm_account_setup_tasks from public, anon, authenticated;
grant select, insert, update on public.crm_account_setup_tasks to service_role;

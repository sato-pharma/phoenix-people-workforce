-- The CRM account setup queue is FIELD ROLES ONLY, from 2026-09-08.
--
-- 20260907213000 shipped this table with a comment arguing the opposite — that a row is opened for
-- EVERY new employee "deliberately, rather than for a guessed list of field-force job titles". That
-- was the rule for one day, and the owner narrowed it the next: field roles only.
--
-- This migration exists because that comment is now WRONG and it is wrong in the convincing
-- direction. It reads as a considered decision with its reasoning attached, so a session that finds
-- the code filtering by title would take the comment as the spec and the filter as the bug, and
-- "fix" it by reverting to notifying everyone. The migration FILE is left alone — it is a
-- historical record of what was applied — but the comment on the live object is corrected, because
-- that is what anyone actually inspecting the database reads.
--
-- The rule itself: `needsCrmAccount` (src/lib/crm/account-setup.ts) delegates to
-- isFieldWorkforceComplianceEligibleTitle, so "needs a CRM account" and "is field workforce" can
-- never disagree. A BLANK title counts as in scope — it means nobody has said yet, not head office.
--
-- Measured on production before choosing it: of 122 active employees, 107 hold a field title, 13
-- are head office, and 2 have no title at all. Area was considered as a second signal and rejected
-- on a measurement — EVERY head-office employee carries an area_id, because "Head office" is itself
-- an area, so an area test would silently re-admit all 13.

comment on table public.crm_account_setup_tasks is
  'One row per newly created employee IN A FIELD ROLE: has somebody given this person an iReports360 (CRM) account, or ruled that they do not need one. Head office does not open a task (owner, 2026-09-08) — a queue that asks a question with the same answer every time stops being read. Opened by the employee-create paths through openAndAnnounceCrmAccountSetup, cleared on the CRM workspace''s New Hire CRM Setup tab.';

comment on column public.crm_account_setup_tasks.source is
  'Which create path opened this task — a manual add on the employee master, or a confirmed employee import. Both go through one entry point, so neither can open a task without also sending the notice.';

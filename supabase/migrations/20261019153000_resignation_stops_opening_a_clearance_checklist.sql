-- A resignation stops opening a clearance checklist that nothing can close.
--
-- WHY. The Clearance & Offboarding module was removed from the app on 2026-09-01 at the owner's
-- instruction (#2863: "Clearance gone — the whole module"). That removed every screen, route and
-- permission, but not this trigger, so every resignation recorded since still opened a seven-desk
-- checklist (line manager, IT, fleet, stores, finance, HR records, admin) that no screen can tick.
-- Read from production on 2026-10-19: 34 open checklists, 238 pending items, none ever ready or
-- released, the newest opened on 2026-10-18. An open checklist therefore said nothing about a
-- leaver's settlement while reading exactly as if it did.
--
-- Owner decision, 2026-10-19: stop the trigger; the checklists already opened stay as history, and
-- clearance stays on the signed paper (HR Forms, إخلاء طرف موظف).
--
-- WHAT STAYS. The three hr_clearance_* tables, every row in them, and the four other clearance
-- functions (refresh_status, open, decide, release). They hold the settlement evidence from the
-- days the module was live, and tests/hr-retention-register.test.ts still pins their RLS and ACLs.
-- Only the trigger and the trigger function it called go; the function was service_role-only and
-- had no caller but this trigger.
--
-- Recording a resignation never depended on this: the trigger was best-effort by design and
-- swallowed its own errors, so removing it changes nothing about how a resignation is saved.
-- Mailbox offboarding has its own register (20260830001000) and never read these tables.

drop trigger if exists trg_hr_clearance_on_resignation on public.employee_resignations;
drop function if exists public.phx_hr_clearance_on_resignation();

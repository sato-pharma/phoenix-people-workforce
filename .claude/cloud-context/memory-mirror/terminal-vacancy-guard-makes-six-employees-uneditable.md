---
name: terminal-vacancy-guard-makes-six-employees-uneditable
description: "The terminal-vacancy guard used to abort any HR edit it could not open a vacancy for (23505, two modes) — FIXED in prod + staging 2026-08-19, PR #2195: opening is now best-effort. Do not make it mandatory again."
metadata:
  node_type: memory
  type: project
---

Found 2026-08-19 in production (`ozucdzovmcqvepbozvqf`) while normalising region-label casing: an
`UPDATE public.employees` on a resigned employee failed with
`23505 duplicate key ... position_vacancies_vacancy_code_key`.

**Why.** Trigger `phx_employee_terminal_vacancy_guard` fires `AFTER INSERT OR UPDATE OF
employment_status, payroll_eligible, organogram_visible, manager_hr_id, department_id, line_id,
area_id, position_id, job_title, region_name` — ten columns, so almost any HR edit re-runs it. It
calls `phx_ensure_terminal_employee_vacancy(hr_id)`, which searches only for a vacancy whose
`status = 'open'`. If the employee's replacement vacancy was later **cancelled or filled**, nothing
is found, so the function builds the deterministic code
`VAC-TERM-<HRID>-<substr(md5(hr_id||'|'||effective_date),1,6)>` and INSERTs — colliding with the very
row it should have reused. The whole transaction aborts.

**Blast radius, measured 2026-08-19: 6 terminal employees are completely un-editable.**
`B-85` (collides with filled 291), `B-101` (filled 251), `B-114` (cancelled 295), `B-153`
(cancelled 294), `B-168` (cancelled 290), `B-183` (filled 296). Any HR edit to one of those ten
columns on any of them fails. It is not restricted to those six — the set grows whenever a terminal
employee's auto-vacancy is cancelled or filled.

**Why: the guard's "does a vacancy already exist" test and its "what code would I create" test
disagree.** The lookup is status-scoped; the code is not.

**How to apply:** before updating a terminal employee's row, check whether that deterministic code
already exists. Fixing it properly means changing the function (search by `vacancy_code` /
`replacement_for_hr_id` regardless of status, and reopen rather than insert) — that is a
**production migration and needs the owner's explicit approval**. Do not work around it by disabling
the trigger. Note the same call also runs `phx_release_terminal_manager_ownership`, so touching a
resigned employee's row has real side effects beyond the vacancy — never do it for a cosmetic
change. See [[public-areas-never-got-the-beni-suef-split]] for the label work that surfaced this.

## FIXED 2026-08-19 — applied to PRODUCTION and STAGING, do not undo

Migration `20260819060000_terminal_vacancy_guard_duplicate_code.sql`, PR
[#2195](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2195). Applied by hand to both
projects **before** the PR, per [[railway-deploy-applies-no-migrations]].

**The staging rehearsal found a SECOND failure mode the production error had hidden.** The guard's
lookup also requires a blank `replacement_for_hr_id`, so it cannot see an open rep vacancy on the
same line/area belonging to somebody else; the insert then trips
`phx_guard_single_open_rep_vacancy`, which raises with `errcode = 'unique_violation'` — the *same*
SQLSTATE 23505, from a completely different place. A fix that only handled the duplicate code would
have looked green and still broken. Staging reproduced mode A on B-183 and mode B on B-160.

**The fix: opening a vacancy is BEST-EFFORT, not mandatory.** `on conflict (vacancy_code) do
nothing` inside a plpgsql block that catches `unique_violation`; the block's subtransaction rolls
back the failed insert alone, so the caller's edit survives. The guard then adopts the existing row
and returns `applied=false` with reason `existing_closed_vacancy` or `vacancy_insert_blocked`.

**It must never reopen what it finds** — cancelled means a human decided not to backfill, filled
means the replacement already happened, and in mode B the line/area already has its one permitted
open rep vacancy. Verified: prod vacancy totals held at 106/37/29/40 and the six colliding rows kept
their exact statuses; staging held 86/39. The NEVER-ZERO invariant still holds (a terminal employee
with no vacancy still gets one: staging 86 -> 87).

**How to apply:** if this ever needs changing, the trap is that `23505` here means two different
things. Do not "simplify" the guard back into an unconditional insert, and do not disable the
trigger to work around it. `tests/resignation-completion-vacancy.test.ts` pins lookup-before-insert
and insert-in-the-else-branch against the BASELINE file, which this migration does not touch.

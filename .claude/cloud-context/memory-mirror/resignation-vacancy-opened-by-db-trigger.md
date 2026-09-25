---
name: resignation-vacancy-opened-by-db-trigger
description: "A terminal-lifecycle write on employees OPENS the replacement vacancy via a DB trigger — never add an app-side vacancy insert to a resignation/termination path or you double the seat"
metadata: 
  node_type: memory
  type: project
  originSessionId: e267bf0f-f0f3-4fab-a70c-09700ca8e415
  modified: 2026-08-01T17:38:07.321Z
---

Found 2026-08-01 while doing the PR #1594 follow-up (landed as PR #1599, `a984f845`).

## The trap

Any `UPDATE public.employees` that sets `employment_status` (or `payroll_eligible` /
`organogram_visible` / the org columns) fires:

```
phx_employee_terminal_vacancy_guard
  AFTER INSERT OR UPDATE OF employment_status, payroll_eligible, organogram_visible,
    manager_hr_id, department_id, line_id, area_id, position_id, job_title, region_name
  ON public.employees  ->  phx_ensure_terminal_employee_vacancy(hr_id)
```

`phx_ensure_terminal_employee_vacancy` **adopts** the seat's existing open vacancy when one exists
(matching `replacement_for_hr_id = hr_id`, else an unclaimed open row matching
area+line+position+manager) and inserts `VAC-TERM-<HRID>-<md5:6>` only when there is none. It fires
whenever the new `employment_status` is `resigned|terminated|inactive` — exactly the set
`normalizeEmployeeExitStatus` returns.

🔴 **So the vacancy is ALREADY open by the time your TypeScript continues.** Adding an app-side
`insertFallbackVacancy` to a resignation/termination path gives the seat **two** open vacancies —
and because the paths mint different codes (`vacancyCodeFromEmployee` → short code vs `VAC-TERM-…`),
the unique index on `position_vacancies.vacancy_code` does **not** catch it.

Nothing in TypeScript says any of this. `src/lib/resignations/service.ts` reads as if the service
owns vacancy creation. It does not.

## What IS missing, and is safe to do

The trigger only touches `position_vacancies`. It never links the record back. A resignation raised
through `createResignation` keeps `vacancy_id = null` / `create_vacancy = false` (only
`resignEmployeeAndOpenVacancy` ever set them, and `employee_resignations` has **zero triggers**),
while `replacementForVacancy()` in `src/lib/employees/employee-directory.ts` resolves "who does this
vacancy replace" through exactly that column. PR #1599's `linkCompletedResignationVacancy` reads the
open vacancy back and stamps it; it inserts only after a completed read PROVES the seat has none,
and fails **closed** on an unreadable table.

⚠️ Match the SQL guard's status normalization — `lower(coalesce(status,'open')) = 'open'`. A plain
`.eq("status","open")` misses NULL/`'Open'` rows, reads as "no vacancy", and opens the duplicate.

## Prod numbers at the time (ozucdzovmcqvepbozvqf)

31 resignation rows, **all** with `create_vacancy=true` + a `vacancy_id` — so every live resignation
came from the Employees-page path and `createResignation` has never produced a prod row. Of 33
terminal employees: 24 exactly one open vacancy, 7 already filled, 2 with two open (B-150, B-174 —
explained by migration `20260801160000` / #1591 deliberately reopening them, NOT by the guard).
The Employees-page path fires the guard three times per resignation and still yields one vacancy —
direct evidence the adopt-or-insert is idempotent.

## Still open

Completing a resignation does **not** vacate the `au` seat, which
`phx_resign_employee_and_open_vacancy` does at step 5 via `au.resign_occupant`. **No TypeScript in
`src/` touches the `au` schema at all** — it is driven purely from SQL — so closing that needs a
migration (a `public.phx_*` wrapper or PostgREST exposure). `au.resign_occupant` is NOT idempotent:
it raises if the seat is missing, has no open span, or is already vacant — guard on an open
`au.occupancy_history` span first, as the RPC does.

Related: [[organogram-vacancy-occupancy-truth]] (its line "resignation service already opens
vacancies" is true only of the Employees-page path), [[employee-hire-auto-replacement-double-seat]],
[[list-migrations-reports-ledger-not-reality]] (how the trigger was confirmed: `pg_proc`/`pg_trigger`,
not the ledger).

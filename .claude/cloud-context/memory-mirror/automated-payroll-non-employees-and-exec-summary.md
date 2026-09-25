---
name: automated-payroll-non-employees-and-exec-summary
description: "Non-Employees Payroll (people paid monthly with NO HR_ID record) + an Executive Summary sheet — PR #1335, merged 2026-07-25. The production migration IS applied and the table holds real payees: do NOT re-apply it, and never tell the owner the feature is unusable on production. DURABLE: getNonEmployeePayrollRows swallows missing-table errors on purpose, and July never shows a month-over-month comparison by explicit design (AUTOMATED_PAYROLL_LAUNCH_PERIOD), not by accident."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-25T15:09:27.643Z
---

**Non-Employees Payroll** (owner spec, Arabic/Arabizi request): people paid a
monthly salary with NO employee/HR_ID record at all. Deliberately built as a
standalone CRUD surface, NOT wired into the StepKey/DraftRow/recommend.ts
wizard machinery — there is no population to recommend against, just a
free-form list HR adds to/removes from directly (fields: Name AR, Name EN,
Total Salary, Bank Name, Bank Account). New table
`automated_payroll_non_employees` (migration
`20260725130000_automated_payroll_non_employees`), new service file
`src/lib/automated-payroll/non-employees.ts`, new API routes under
`/api/automated-payroll/runs/:runId/non-employees[/:id]`, new UI component
`non-employees-panel.tsx` wired into the wizard via a dashed-border pill
OUTSIDE the PART1_STEP_KEYS pill strip (not a real StepKey). Locked the same
moment every Part 1 tab locks (`run.phase !== "part1"`). Appended ONLY to the
exported Part 1 xlsx sheet's own mini-section + grand total (`writePayrollWorksheet`
now returns `{sheet, nextRow, firstPartTotal}` so callers can append after it) —
deliberately never touches AssembledRow/DraftRow/publishToPayslips, since these
people must never generate a real employee salary_record.

**Real regression caught + fixed before shipping:** `buildRunSheet`'s Part 1
variant and `buildFinanceSheet`'s Part 1 scope now unconditionally call
`getNonEmployeePayrollRows(runId)` — but production doesn't have this new
TABLE yet (only staging does; production migration needs its own separate
approval per this repo's policy, distinct from the staging approval already
given). A genuinely missing table throws a Postgres 42P01/PostgREST error,
which would have 500'd the ALREADY-WORKING "Download Part 1 sheet" and
"Finance Part 1 download" buttons the moment this code shipped — before the
migration could catch up. Fixed by making `getNonEmployeePayrollRows` swallow
missing-table errors and return `[]` (same tolerance idiom used throughout this
codebase for add-only migrations — see calendar/service.ts, crm/schema.ts).
Verified live: Part 1 sheet download against production still returns 200
(28KB) with the table absent; the non-employees GET endpoint itself returns
`{success:true,rows:[]}` instead of erroring. Schema itself (insert, the
`total_salary >= 0` check constraint, cascade delete) verified via a direct
SQL smoke test against staging (insert → constraint-rejects-negative → delete).

**Executive Summary Dashboard** (owner follow-up ask, same session): a new
"Executive Summary" worksheet appended to both `buildPart1SheetWorkbook` (Total
First Part) and `buildFullSheetWorkbook` (Total Month Salary) — headcount +
total value THIS month vs the previous month's PUBLISHED run, with a signed %
change and green/red delta coloring (reusing the INCREASE/DECREASE fill+text
constants already defined for the existing "Salary Changes" sheet). New
`previousMonthSummary(period, valueField)` in run-service.ts queries
`salary_records` for the prior published batch (mirrors the existing
`previousMonthNetSalaryByHrIdCompact` pattern). Honest empty state when there's
no previous month (first-ever run): shows "—" placeholders, NOT a misleading
0 or 100%-increase — verified live against the real July 2026 run (which has no
prior automated-payroll month to compare against): 118 employees, EGP
1,756,785.77 Total First Part, "no previous month to compare" shown correctly.

**Owner follow-up during the same session**: "treat july as a fresh [start],
starting from august compare" — added an explicit
`AUTOMATED_PAYROLL_LAUNCH_PERIOD = { month: 7, year: 2026 }` constant and
`isAtOrBeforeLaunch()` guard in run-service.ts, applied to BOTH
`previousMonthSummary` (Executive Summary) and `previousMonthNetSalaryByHrIdCompact`
(the older Salary Changes tab) — July never shows a comparison by explicit
design, not by incidentally having no prior published run. Guarded by a
dedicated test (prove-it-fails verified) and live-checked against the real
production July run.

**Status: PUSHED to PR #1335** (commit `ca008a09`, same branch/PR as
[[automated-payroll-special-situations-tab]]) — both features + the
regression fix + the launch-period guard landed together. Staging migration
applied; production migration for `automated_payroll_non_employees` still
needs its own separate approval before Non-Employees Payroll can be used on
production (until then, the missing-table tolerance keeps existing downloads
working, just with an empty Non-Employees section).

## 2026-09-04 — the production migration is APPLIED, and the table is in use

The description and the closing paragraph both said the **production migration for
`automated_payroll_non_employees` still needs its own separate approval before Non-Employees
Payroll can be used on production.** Both are now wrong, and wrong in the direction that costs
something: a session reading them would either re-apply a live migration or tell the owner a
working feature is unavailable.

Queried against production `ozucdzovmcqvepbozvqf` (`pg_class`, not the migration ledger, which
reports intent rather than reality):

| | |
| --- | --- |
| `public.automated_payroll_non_employees` | **exists**, `relkind = 'r'` |
| RLS | **on** |
| rows | **14** |

Fourteen rows means this is not merely migrated — **real people are being paid through it.**
Treat the table as live production payroll data.

`gh pr view 1335` — **MERGED 2026-07-25T16:37:36Z**, merge commit `774c3faf`, branch
`codex/automated-payroll-part1`.

**Two design facts above are durable and still load-bearing**, which is why this file stays:

1. `getNonEmployeePayrollRows` swallows a missing-table error and returns `[]` **on purpose.** It
   is not a bug to tidy away. It exists so an add-only migration lagging the deploy cannot 500
   the already-working Part 1 and Finance downloads. (It also predates the rule now in
   `AGENTS.md` §2.1 that a missing table answers `PGRST205`, not `42P01` — if you touch that
   tolerance, handle both.)
2. **July 2026 never shows a month-over-month comparison**, by the owner's explicit instruction
   ("treat july as a fresh start, starting from august compare"), enforced by
   `AUTOMATED_PAYROLL_LAUNCH_PERIOD` and `isAtOrBeforeLaunch()`. A future session finding July
   blank is looking at the design, not a gap.

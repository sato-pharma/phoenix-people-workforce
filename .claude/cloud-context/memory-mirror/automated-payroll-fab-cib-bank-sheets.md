---
name: automated-payroll-fab-cib-bank-sheets
description: "SHIPPED 2026-07-26 in PR #1354 — FAB + CIB bank-transfer sheet exports, plus non-employees rendered as inline rows (appendNonEmployeesSection deleted). The \"uncommitted, awaiting an edit before shipping\" framing was overtaken within a day. DURABLE: these are zero-deviation replicas of the owner's real bank submission files, driving real money movement, so a styling tidy-up is a production defect."
metadata: 
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-25T22:30:31.521Z
---

Built and fully validated (typecheck/lint/test all green, 446 test files) but **NOT shipped** — sits uncommitted in worktree `F:\Phoenix Workforce\_wt-automated-payroll-part1` as of 2026-07-26:

1. **FAB bank-transfer sheet** — `src/lib/automated-payroll/exports/fab-sheet.ts`, wired into `buildFabSheet` (run-service.ts), route `app/api/automated-payroll/finance/fab-download/route.ts`, access-registry entry, two buttons ("Download FAB Sheet — Part 1/2") in `finance-download-panel.tsx`, tests in `tests/automated-payroll-fab-sheet.test.ts`. Literal replica (schema + colors/fonts) of the owner's real FAB.xlsx bank-submission file — verified cell-by-cell, including the header's light-yellow fill (ARGB FFFFFF99) the owner caught me missing on the first pass.
2. **CIB bank-transfer sheet** — same pattern, `exports/cib-sheet.ts` / `buildCibSheet` / `finance/cib-download` route / tests in `automated-payroll-cib-sheet.test.ts`. Reverse-engineered from the owner's real `details_Sheet.xls` (fixed-width mainframe-style format, "042" branch code, 13-digit zero-padded Amount). Distinctive styling: bold dark-red-on-yellow header (FF800000 on FFFFFF00), yellow-highlighted Employee_Account_No column with hairline borders, "Traditional Arabic" font on the raw Amount column. Owner caught a second miss: the reference file has a SECOND column literally labeled "Amount" (a real readable number, not the fixed-width code) right after the Name annex column — added back.
3. **Non-Employees Payroll restructuring** — `writePayrollWorksheet` in `exports/sheet.ts` (and `finance-sheet.ts`) now renders non-employee entries as regular ADDITIONAL ROWS in the main table (name under "Full Name", amount under "First Part"/"Month Salary") instead of a separate captioned section with its own subtotal/grand-total. `appendNonEmployeesSection` was deleted entirely. Test rewritten in `automated-payroll-non-employees.test.ts`.

**Why:** owner wants literal, zero-deviation bank-execution files ("no mistake") generated from inside the system instead of hand-built externally — this is real money movement to FAB and CIB.

**Known open item**: the separate "Executive Summary" tab (`addExecutiveSummarySheet`) still totals only real employees — doesn't fold in non-employees, so it may read slightly lower than the main sheet's TOTALS row when non-employees exist. Flagged to owner, not fixed (out of the asked scope).

**How to apply:** owner paused shipping mid-session ("wait do not ship") to go work on something else, then said in a follow-up message they want to **edit the Non-Employees Payroll part** before shipping — no specifics given yet. A spawn_task chip (`task_f3c2b842`) captures the full handoff (ship workflow + "ask owner what to edit first"). Do not ship any of this without checking that edit request first. See [[automated-payroll-part1-enhancements]] and [[automated-payroll-non-employees-and-exec-summary]] for the original Non-Employees Payroll design history.

## 2026-09-04 — SHIPPED; the "do not ship" hold was lifted the next day

The body says this sat **uncommitted in `F:\Phoenix Workforce\_wt-automated-payroll-part1`** and
must not ship until the owner said what he wanted edited. He evidently said it: the work landed
the following day.

Verified in the checkout, 2026-09-04:

- first landed `ecc55444c` **2026-07-26** — *feat(automated-payroll): FAB/CIB bank-transfer
  sheets, inline non-employee rows, accurate exec summary* (**#1354**)
- all six files present on `main`: `exports/fab-sheet.ts`, `exports/cib-sheet.ts`, both
  `finance/{fab,cib}-download` routes, both test files
- `appendNonEmployeesSection` — **0 hits** across `src` and `tests`, deleted exactly as item 3
  describes
- the worktree `_wt-automated-payroll-part1` is **gone**
- and it has been maintained since: `810ea993a` **2026-08-08** (#1902) *Full sheet gets bank
  details, FAB Part 2 relabels Salary as Expense*

**The instruction that outlived the status:** these sheets are literal replicas of the owner's
real FAB and CIB submission files, down to the ARGB fills, the "Traditional Arabic" font and the
13-digit zero-padded amount. They execute real transfers. Never "clean up" the styling or
collapse a duplicated-looking column — the owner caught two such omissions during the original
build, and both were things that only matter to the bank.

The **known open item** above is the one thing here that may still be true: the Executive Summary
tab totals only real employees, so it can read lower than the main sheet's TOTALS row when
non-employees exist. That was flagged and deliberately not fixed. Check it before quoting the two
figures against each other.

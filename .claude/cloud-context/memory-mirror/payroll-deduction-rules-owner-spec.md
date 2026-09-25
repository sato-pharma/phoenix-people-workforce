---
name: payroll-deduction-rules-owner-spec
description: "Owner's dictated business rules for the automated monthly payroll sheet (deductions, AV/leave, proration, expenses, part1/part2) — the spec the Payroll Copilot must fully implement"
metadata: 
  node_type: memory
  type: project
  originSessionId: dc87c264-63ec-46bc-b397-ee25de8604a0
---

Owner dictated (2026-07-07) the exact rules the Payroll Copilot must automate to produce a monthly payroll sheet identical to his manual one. Verify each against current code before building; confirm the NEW ones with him.

**1. National-holiday bridging leave (NEW — the key new rule).** First determine if the month contains a national holiday (`getConfirmedNationalHolidays`). Any leave taken **directly before or directly after** a national holiday is **deducted from salary automatically — whether the employee has leave balance or not** (you do NOT spend balance for it; it's a straight salary deduction). This is an anti-"long-weekend-bridging" penalty.

**2. Determine the source per signal** — is a day's status coming from Visit Report or from Workforce Compliance (FWC / ireports360_visits)? Resolve the authoritative source before acting.

**3. N (no activity) → always a deduction.** Whoever has N days must be deducted (the CRM/no-activity deduction).

**4. AV (vacation/leave) → balance-first.** AV = a vacation/leave day. If the employee HAS leave balance → subtract from balance. If NO balance → subtract from **salary**. (Except rule 1: bridging-a-holiday AV is always salary, balance or not.)

**5. Mid-month hire → prorate** (joiner settlement).

**6. Resignation → settlement** (leaver rules already in proration.ts).

**7. Expenses lag one month.** June payroll includes the **outstation expenses of MAY** (the prior month's approved outstation that is transferred/paid within June). So the expense window is the PRIOR calendar month's approved outstation, paid in the current payroll.

**8. Part 1 / Part 2 split.** Some positions are paid **Part 1 only**; others Part 1 + Part 2 (with breakdown). **Anything classed as "expenses" is ALWAYS added to Part 2** — even for an employee who otherwise takes salary on Part 1 only.

**Deliverables he wants (reports):** CRM/workforce deductions report; vacations-with-no-balance report; fingerprint deductions report. All feeding one automatic payroll sheet that mirrors his manual payroll sheet (inspect the real payroll module / SalaryReportTable / salary-sheet-fields for the exact format).

Cross-check status vs the Copilot: proration (joiner/leaver) DONE; CRM/fingerprint feeders DONE; **expenses prior-month lag FIXED 2026-07-08** (sourceExpenseMonthBounds in expense-review.ts) + always-part2 (unchanged, already correct); AV balance-vs-salary (vacation-settlement flow, unchanged); **national-holiday bridging rule BUILT 2026-07-08** (holiday-bridging.ts) — mandatory salary deduction for the single day adjacent to a confirmed holiday, balance untouched either way, single-adjacent-day scope not whole request — all 3 design questions confirmed explicitly by owner. See [[payroll-copilot-report-exports]] for PR #945 + migration-approval status (draft migration NOT yet applied). Locked: policy.ts, scheme-2026.ts.

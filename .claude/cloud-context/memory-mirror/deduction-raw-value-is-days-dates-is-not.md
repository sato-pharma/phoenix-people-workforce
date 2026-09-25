---
name: deduction-raw-value-is-days-dates-is-not
description: "deductions_candidates.raw_value is FRACTIONAL DAYS; dates[] is one entry per calendar date — never use dates.length as a day count"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d66b5e6-1a1a-44ee-8e95-86506c216715
  modified: 2026-08-05T11:33:50.136Z
---

In `deductions_candidates`, `raw_value` is the quantity in **days and is routinely fractional**
(fingerprint late arrivals are 0.07 / 0.13 / 0.25 / 0.50), while `dates` is **one entry per
calendar date touched**. The two are equal only for whole-day categories (CRM no-activity:
5 days = 5 dates), which is exactly why treating them as interchangeable survives review.

`dates.length` is therefore **never** a day count. Anything dividing by `raw_value` and
multiplying by a date count rescales a partial day to a full day.

**Why:** found 2026-08-05 — the payroll bridge `candidateAmount`
(`src/lib/automated-payroll/deductions-source.ts`) scaled on `resolveAppliedDeductionDates().length`.
Armed but never fired on live July 2026 data: 62 candidates / 21 employees, 26,671.23 EGP of real
deductions would have reached the sheet as 70,545.20 EGP (+43,873.97), worst row 14.3x (0.07 days:
15.73 → 224.71 EGP). Only "Approved for Payroll" rows pay, and every fractional row was still
Pending — approving one was all it took. The module's own publish path never had this (it uses
`appliedAmount ?? estimatedAmount`, no scaling), so the two screens disagreed on identical rows.

**How to apply:** scale on real days — the reviewer's stored `appliedValue`, else `raw_value`, else
apportion pro-rata by the *fraction* of dates kept (`raw_value × kept/detected`). In practice
`resolveDecisionCharge` always writes `applied_value` + `applied_amount` together whenever days are
narrowed, so a narrowed row short-circuits before any scaling. Two known sites still derive days
from a date count and are correct only because that `appliedValue`-first branch wins:
`appliedDaysOf` in `src/components/admin/deductions-workspace.tsx`, and the
`appliedValue > rawValue` guard in `resolveDecisionCharge`
(`src/lib/deductions/service.ts`) — which rejects narrowing a 0.13-day row with
"cannot deduct 1 day(s) — only 0.13 were detected". See [[direct-order-pricing-rule-locked]] for the
other money rule that must not be re-derived.

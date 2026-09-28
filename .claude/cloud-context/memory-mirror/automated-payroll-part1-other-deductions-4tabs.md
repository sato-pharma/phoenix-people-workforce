---
name: automated-payroll-part1-other-deductions-4tabs
description: "Automated Payroll's Part-1 'Other deductions' is 4 tabs — p1_crm / p1_unpaid_vacation / p1_no_record / p1_other_deductions (Loan & Other) — shipped bfa99d75b 2026-07-25. TWO durable money-safety rules: the double-deduction guard isSettledInPart1 (leaver || one_part) must gate BOTH the Part-1 tabs and the Part-2 auto-recommend or a one-part employee is deducted twice; and the leaver/Resignations overlap is a WARNING, not a block (owner chose 'keep both, add a warning') — never turn it into a block. Plus: a local run of this module writes PRODUCTION payroll, so 'write once and immediately revert' is NOT a safe way to verify persistence."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-09-26T00:28:52.016Z
---

The single `p1_other_deductions` step (5 categories in one table) is now **4 wizard tabs**:
`p1_crm` (CRM only), `p1_unpaid_vacation` (Unpaid Vacation only), `p1_no_record` (Day Without Record
only), and `p1_other_deductions` (key kept, retitled "Other Deductions (Loan & Other)"). Shipped
`bfa99d75b` 2026-07-25; pure UI/service reorg in `src/lib/automated-payroll/`, **zero schema change** —
the `p1od_*` columns pre-existed, and `assemble.ts`'s money math (`otherPart1DeductionsTotal`,
`freezeFirstPart`) sums by field NAME regardless of which UI step wrote it, so moving fields between tabs
never touches the total.

## 🔴 The double-deduction guard — `isSettledInPart1(member, source)`

`isSettledInPart1 = member.lifecycle === "leaver" || source.paymentMode === "one_part"`. It must be used
in **both directions**: the Part-1 tabs show **only** these employees, and the Part-2 auto-recommenders
`recommendCrm` / `recommendVacation` **skip exactly these same** employees. If it gates only one side, a
**one-part employee appears in both `p1_crm`/`p1_unpaid_vacation` AND `p2_crm`/`p2_vacation`** — those
write *different* draft columns (`p1od_crm_value` vs `crm`) and `assemble.ts` sums BOTH, so the deduction
is taken **twice** (or, once Second Part clamps to 0, the excess is silently stranded in
`overpaidResidual`, which nothing carries forward — [[automated-payroll-carry-forward-and-accuracy-nets]]).
Pinned by `tests/automated-payroll-part1-scope.test.ts` (the populations must be disjoint). The reason
the rule spans both parts: leavers and one-part employees are already settled once — leavers in the
`p1_resignations` step, one-part employees by having no second part — so a second value here double-counts.

## 🔴 The leaver / Resignations overlap is a WARNING, not a block

Owner chose **"keep both, add a warning"** (2026-07-25) — **a future session must NOT turn it into a
block.** `src/lib/automated-payroll/conflicts.ts` holds the rule as three pure functions
(`settledElsewhereAmount` / `enteredOnThisStepAmount` / `hasDoubleDeductionConflict`), driven
declaratively by `StepDefinition.conflictContextKey`, set to `"Settled in Resignations"` on **`p1_crm` and
`p1_unpaid_vacation` only** (a leaver's CRM/Vacation is auto-computed on `p1_resignations`, and typing a
value for that same leaver in these manual tabs would deduct it again). The warning reads the **same draft
columns `assemble.ts` sums**, so it reflects exactly what will be deducted; an unsaved Resignations
recommendation isn't deducted, so not warning on it is correct. UI: orange banner naming each affected
employee with both amounts, and the warning outranks the leaver red row-tint. Rule lives in a lib file so
it is unit-tested, not eyeballed. **Known gap:** the wizard doesn't enforce Part-1 step order, so
confirming the CRM tab before Resignations shows no warning at typing time (it appears on revisit); Part-1
confirm requires all steps confirmed, so the natural order works, but a confirm-time gate would close it
fully.

## 🔴 Local verification of this module WRITES PRODUCTION — don't

A worktree/local dev server has `.env.local` pointed at **production** Supabase, so **any** mutating call
(PUT/POST/save/confirm/import-commit) writes real HR payroll onto the currently-active run — and `curl PUT`
is the same HTTP call as clicking Save. **"Make one real write and immediately revert" is NOT safe** and
is not a substitute for asking: this exact mistake hit this exact module **twice in 24 hours**, each time
after the prior memory said not to. Going forward, for this module and any module with a prod-pointing
local setup: **do not execute a mutating call against a real active production run during local
verification, full stop** — not even a revert-immediately one. Instead (a) trust `typecheck` / `lint` /
full unit suite green plus a careful code read of the (usually small) save-path change, and (b) if a
genuine end-to-end write proof is truly needed, **ask the owner first** whether to test against a
disposable/synthetic future period, rather than deciding unilaterally that "immediately revert" is safe
enough. See [[automated-payroll-part1-enhancements]] and [[local-browser-verify-gotchas]].

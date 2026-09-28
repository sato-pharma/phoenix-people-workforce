---
name: a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace
description: "publishToPayslips filters out on_hold rows, so a held employee is never written to salary_records — and nothing records a payment made outside the system. A hold withholds the SECOND part only, which is often 0.00; and a row can carry a frozen first instalment with a NULL earnings side, which makes part 2 incomputable rather than zero, so releasing it pays nothing."
metadata:
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-09-26T01:15:17.604Z
---

## 🔴 A hold silently deletes someone from payroll, and leaves no trace

`publishToPayslips` drops held rows — `rows.filter((entry) => !entry.onHold)` — so **no `salary_records`
row is ever written for a held person** (`src/lib/automated-payroll/run-service.ts`). The canonical
`salary_batches`/`salary_records` are written **once, at publish** (`types.ts`), so after publish the hold
is unrecoverable through the normal path.

**Nothing records that someone was paid another way.** `payroll_resignation_candidates` looks like a
payout register but is a **detection** table populated from an uploaded salary sheet
(`source_file_name`/`source_row`/`first_seen_at`) — its `last_payout_month` is what a spreadsheet claimed,
not proof a transfer happened. The only place an out-of-band payment is recorded is the free-text
`automated_payroll_draft_rows.hold_reason`, typed by hand — so most holds say nothing and the question has
to be put to the owner.

## 🔴 HELD = OWED PART 2 ONLY, and often nothing — never quote the frozen figure

A hold withholds the **second part only**. **Part 1 is frozen and transferred BEFORE the hold takes effect
at publish**, so for every held person part 1 is already in their bank account. **Quoting
`employees.net_salary` (or `first_part_frozen`) as "still owed" DOUBLE-PAYS part 1** — the owner caught
exactly this (told to transfer a full ~16,500 when the true part-2 figure was ~6,021; *"Don't make the
company pay wrong payments."*). Many held people are owed **nothing at all** — their part 1 equalled their
whole entitlement. The frozen first-instalment amount is **not the stake** and must never be quoted as one.

🔴 **A NULL earnings side is not a zero — it is an unassembled row.** A held row can carry a frozen first
instalment while `days_worked`, `base_for_month`, `ecol_paid`, `fuel_paid` are **all NULL**; the part-2
formula then returns **NULL, not 0**, so **releasing such a row pays nothing** — the row has to be
assembled first. **The tell is `first_part_frozen IS NOT NULL AND base_for_month IS NULL`.** These are NOT
the run's `excluded` rows, so `excluded` does not identify this shape.

## The part-2 formula — and validate it against PUBLISHED rows before quoting

```
  base_for_month + ecol_paid + fuel_paid   (or employees.net_salary for a full month)
+ expenses + incentive + bonus + overtime + special_addition_value
− crm − manual_other_deductions − unpaid_vacations − fingerprint_value
− special_deduction_value − every p1od_*_value
− medical_insurance − first_part_frozen          , floored at 0
```

**Validate any such derivation against the rows that WERE published before quoting it.** The obvious short
version — net minus the row's deductions minus part 1 — reproduced only ~72% of known second parts; the
three terms it dropped were **`expenses`** (a reimbursement, and the single commonest cause),
`special_addition_value` and `special_deduction_value`. With those it reproduces nearly all; the residue
is people whose `employees.net_salary` is **NULL**, so the fallback has no input — and **Postgres
`greatest()` ignores NULLs, silently turning a missing input into 0 rather than an error.** Medical
insurance is the one estimated input (taken from each person's most recent payslip).

## Do not read absences or flags as alarms

- 🔴 **A leaver can never be caught up by a later run.** `loadRunContext` strips departed employees from
  the population, so an earlier month for someone who left later has no run that can carry it — the only
  route is a manual transfer ([[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]]).
- **`payroll_eligible = false` is normal, not a fault** (`src/lib/imports/employee-lifecycle.ts`): the CEO
  and other executives/advisors are `payroll_eligible=false` but very much active. Never read the flag as
  evidence someone was wrongly excluded.
- **`employees.net_salary` carries a rate even for people never in a salary run** — "no salary history" is
  not "no rate on file". Check BOTH tables before saying a rate is missing anywhere.
- **A "who is unpaid" anti-join must key on `hire_date <= month end`** — someone hired after the month is
  correctly held with no entitlement, not an unpaid employee.

## 🔴 Re-confirm a hold's ruling against CURRENT state before re-raising anyone

`hold_reason` carries the owner's ruling — **read it, never re-raise.** But a memory (and a stamped
reason) is point-in-time: a person recorded as *"active, hold deliberate, do not re-raise"* can later read
`resigned`. **The ruling has not been withdrawn; her circumstances moved under it.** On such a hit,
re-confirm the ruling against current state — do not treat the old ruling as wrong, nor the new state as an
alarm.

Related: [[reps-who-never-appear-in-any-salary-record]] ·
[[one-part-employees-have-no-part-2-for-deductions-to-land-in]] ·
[[exit-records-copy-one-date-into-all-four-columns]] ·
[[payroll-mutations-were-unaudited-until-2026-08-21]]

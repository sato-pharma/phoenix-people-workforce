---
name: a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace
description: "publishToPayslips filters out on_hold rows, so a held employee is never written to salary_records — and nothing records a payment made outside the system. A hold withholds the SECOND part only, which is often 0.00; and a row can carry a frozen first instalment with a NULL earnings side, which makes part 2 incomputable rather than zero, so releasing it pays nothing."
metadata:
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-09-04T00:00:00.000Z
---

**A hold silently deletes someone from payroll.** `publishToPayslips` drops held rows —
`rows.filter((entry) => !entry.onHold)` — so no `salary_records` row is ever written for them
(`src/lib/automated-payroll/run-service.ts:708-710`, in a comment that exists because the same
filter was already found to write off carry-forward debts for people who were never charged). The
canonical `salary_batches`/`salary_records` are written **once, at publish**
(`src/lib/automated-payroll/types.ts:7`), so after publish the hold is unrecoverable through the
normal path.

**And nothing records that someone was paid another way.** `payroll_resignation_candidates` looks
like a payout register and is not: `source_file_name`/`source_row`/`first_seen_at` show it is a
**detection** table populated from an uploaded salary sheet. Its `last_payout_month` is what a
spreadsheet claimed, not proof a transfer happened. The only place an out-of-band payment is ever
recorded is the free-text `automated_payroll_draft_rows.hold_reason`, typed by hand — which is why
**9 of the 12 July 2026 holds said nothing at all** and the question had to be put to the owner.

**Measured in production 2026-08-28 on the July 2026 run** (`2f1660e5-…`, published 2026-08-10
07:11 UTC): 121 draft rows, **15 held**, 0 excluded, and the batch holds **105** salary records.
The 15 = 12 real cases plus 3 people hired 1–2 August who simply had no July entitlement
(`AI-0005`, `AI-0007`, `CN-0006`) — correctly held, and correctly absent from any "who is unpaid"
anti-join keyed on `hire_date <= month end`.

**A leaver can never be caught up by a later run.** `loadRunContext` strips departed employees from
the population, so July money for someone who left in August has no run that can carry it — see
[[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]]. The only remaining route is a
manual transfer, which is exactly why eight of these twelve were settled that way and left no trace.

**`payroll_eligible = false` is normal, not a fault.** `src/lib/imports/employee-lifecycle.ts:19-20`
states it outright: the CEO and other executives/advisors are `payroll_eligible=false` but very much
active. Of the 17 people missing from the July batch, **Sara Samir (`B-156`) was the only one with
the flag true.** Never read the flag as evidence someone was wrongly excluded.

**The owner's rulings, 2026-08-28, collected on an XLSX with a locked dropdown and now written into
`hold_reason` on 11 of the 12 rows** (`B-178` left alone — its existing reason was already right):

- **Paid outside the system (8):** Sameh Ahmed Ezzat (`B-157`), Ahmed Nashaat (`B-175`), Ashraf
  Maged (`B-179`), Fiby Wagdy Luka (`B-52`), Soad Atef (`AI-0003`), Mohamed Hamed (`B-169`), Eman
  Essam (`B-176`, including the extra day below), Fathy Fawzy (`B-178`).
- **Not paid through this system at all, KEEP ON HOLD (3):** Sara Samir (`B-156`), Ahmed Helal
  (`B-3`), Amany Wasiem (`B-111`). Sara is **active and still working** — the hold is deliberate,
  so do not re-raise her as an unpaid employee.
- **Still owed — pay it (1):** **Gerges Sameh Khalil Mahwed (`B-112`), 6,021.39 EGP for July** — the
  SECOND PART ONLY. He left 5 August, so no run can pay him; it must be a transfer.
- **Never started, nothing owed (1):** Abdelrahman Alaa (`AI-0004`), hired and terminated 7 July.
  He is the one case with **no July draft row at all**, so there was nothing to stamp.

**A HELD PERSON IS NOT OWED A FULL SALARY — ONLY THE SECOND PART, AND OFTEN NOTHING.** This is the
correction that matters, and it was caught by the owner, not by me: I told him to transfer Gerges
**16,500** when the true figure is **6,021.39**. Part 1 was frozen and transferred on **2026-07-26**,
*before* the hold took effect at the 2026-08-10 publish — so for every one of these people part 1 is
already in their bank account. Quoting `employees.net_salary` as "still owed" **double-pays part 1**;
on Gerges that was an overpayment of **10,478.61**. His words: *"Don't make the company pay wrong
payments."*

**Six of the twelve were owed nothing at all** — their part 1 equalled their whole entitlement:
`B-157` (part 1 was his entire 55,500 net), `AI-0003` (a 7,450 manual deduction consumed the rest),
`B-169`, `B-176`, `B-178`, `B-111`. Real part 2 existed for only six, totalling **48,730.65** against
the **197,870.97** the first sheet implied — and after the owner's rulings the only payment actually
outstanding is Gerges's 6,021.39.

**The formula, and the fact that the obvious version of it is wrong.** Part 2 is:

```
  base_for_month + ecol_paid + fuel_paid   (or employees.net_salary for a full month)
+ expenses + incentive + bonus + overtime + special_addition_value
− crm − manual_other_deductions − unpaid_vacations − fingerprint_value
− special_deduction_value − every p1od_*_value
− medical_insurance − first_part_frozen          , floored at 0
```

**Validate any such derivation against the rows that WERE published before quoting it.** The obvious
short version — net minus the row's deductions minus part 1 — reproduced only **76 of 105** known
second parts, worst error **5,330**. The three missing terms were `expenses` (a reimbursement, an
addition, and the single commonest cause), `special_addition_value` and `special_deduction_value`.
With those it reproduces **103 of 105**; the last two are people whose `employees.net_salary` is
**NULL** (`A-12`, `B-10`), so the fallback had no input — note Postgres `greatest()` **ignores
NULLs**, which silently turns that into a 0 rather than an error. All twelve held people have a rate
on file, so the formula applies to them cleanly. The one estimated input is medical insurance, taken
from each person's most recent payslip.

**Ahmed Bahaa El Din El Maraghy (`B-185`) has never been paid through this system.** Checked across
all **796** salary records in all **7** batches — that is the entire history, there is no legacy
salary table — on `maraghy`, `maraghi`, `marag`, `bahaa`, `baha`, `el din`, `eldin`, the Arabic
`مراغ`/`بهاء`, and on finance/admin job titles. Zero rows. He is `payroll_eligible=false` like the
CEO. He believes he was on payroll and paid through the system; if that is true it happened outside
these records, and his July ruling is still open.

**One correction to make about rates:** `employees.net_salary` carries a rate even for people who
have never been in a salary run — Soad Atef reads 19,000 and Abdelrahman Alaa 2,500 there while
having zero `salary_records`. "No salary history" is not "no rate on file"; check both tables before
saying a rate is missing anywhere.

Related: [[reps-who-never-appear-in-any-salary-record]] ·
[[one-part-employees-have-no-part-2-for-deductions-to-land-in]] ·
[[exit-records-copy-one-date-into-all-four-columns]] ·
[[payroll-mutations-were-unaudited-until-2026-08-21]]

## 2026-09-04 — two things to check before calling a held person unpaid

**First, compute part 2 before raising the alarm.** The rule above — a hold withholds the second
part only, often nothing — is easy to re-derive wrongly under time pressure, and I did: I told the
owner a held active employee was "paid nothing for a month he worked". **AI-0011 Mohamed Khaled**,
hired 17 Aug 2026, 15 days prorated correctly to `6,774.19 + 967.74 + 241.94 = 7,983.87`, has
`first_part_frozen = 7,983.87`. **His part 2 is 0.00 and the hold withholds no money from him at
all.** What it costs is the payslip record, not pay. The owner kept him held. On the August run 2 of
the 13 held rows were 0.00 this way and the real second instalment across the 8 calculable rows was
**16,222.00**, against **145,401.42** of frozen part 1 — the frozen figure is not the stake and must
never be quoted as one.

**Second, a NULL earnings side is not a zero — it is an unassembled row.** Three held rows carried a
frozen first instalment while `days_worked`, `base_for_month`, `ecol_paid` and `fuel_paid`
were **all NULL**: `B-23` (21,700.00 frozen), `B-156` (19,600.00), `B-25` (11,550.00) — the
three largest frozen amounts in the run, all three resigned 31 August so all three worked the whole
month. The part-2 formula recorded above returns **NULL, not 0**, for these, so
**releasing such a row pays nothing** — the row has to be assembled first. They are *not* the run's
excluded rows (those were `AI-0006`, `PD-0007`, `PD-0011`, none of them held), so
`excluded` does not identify this shape. **The tell is `first_part_frozen IS NOT NULL AND
base_for_month IS NULL`.**

**And re-read this file's own 2026-08-28 rulings before re-raising anyone.** `B-156` Sara Samir is
recorded there as *"active and still working — the hold is deliberate, so do not re-raise her as an
unpaid employee"*, yet by 2026-09-04 she reads `resigned`, last working date 2026-08-31,
`payroll_eligible=false`. **The ruling has not been withdrawn; her circumstances moved under it.**
A memory is a point-in-time record, so the right move on a hit like this is to re-confirm the
ruling against current state, not to treat the old ruling as wrong or the new state as an alarm.

**The owner stopped this line of work on 2026-09-04 and moved August payroll to its own session.**
Nothing beyond the three CRM removals was applied. The 12 remaining hold decisions and 4 undecided
CRM candidates were handed over as `xlsx/august-2026-payroll-part2-decisions-2026-09-04.xlsx` and
are **not** this session's to finish.

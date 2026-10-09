# Approved deductions that never reached the published sheet

Measured on production 2026-10-08, answering "sweep the published months for approved deductions
that were never paid". Two months are published — **2026-07** (published 10 August, 10:11 Cairo)
and **2026-08** (published 8 September, 14:43 Cairo). 2026-09 is still `part2` and 2026-10 is
`part1`, so neither can be swept yet.

**Direction of the error: employees were paid MORE than the approvals intended. Nobody was
over-charged.** Every figure below is money the company did not collect, not money anyone owes back.

## How the sweep is built

For every `deductions_candidates` row in a published month carrying a `deductions_decisions` row at
**`Approved for Payroll`** (and not superseded), compare the owed amount against the figure on the
**published payslip** — `salary_records`, joined on the run's `published_batch_id`. The
category → payslip column map is `deductions_categories.salary_records_column`, read from the table
rather than hand-written: `crm`→`crm`, `fingerprint`→`finger_print`,
`unpaid_vacation`/`insufficient_balance_vacation`→`unpaid_vacations`, `loan`→`loans`,
`no_records_activity`/`other`→`other_deductions`.

Owed is `applied_amount` where the approver typed one, otherwise the connector's `estimated_amount`.

🔴 **Two traps, both of which produce a FALSE "nothing was ever paid".**

- `employee_hr_id_compact` is **lowercase** (`a12`, `cn0003`) while `salary_records.hr_id` carries
  the hyphen (`A-12`). Joining `upper(replace(hr_id,'-',''))` matches **nothing**, and every
  payslip value comes back null — identical to the answer the sweep is looking for. The first run of
  this sweep said 100% of approved deductions in both months went uncollected. Use `lower(...)` and
  prove the join on someone you can see a deduction for.
- Filtering on `applied_amount > 0` drops every decision the approver left unpriced — which is all
  eight of the misses below.

**62** employee×category groups in those two months carry an approved amount above zero.

## Fully missed — approved, payslip published, nothing on the sheet

Not held, not excluded, a real payslip for that month, and the mapped column reads **0 or null**.
Not one of these eight carries a typed amount, so the figure is the connector's own estimate.

### 2026-07 · fingerprint — 8,925.81 EGP

Step `p1_fingerprint` was confirmed **25 July 23:44**; all four decisions were taken **5 August
18:47**, eleven days later. The draft's `fingerprint_value` is **null** on all four — the column was
never written.

| Person | Candidate days | Owed (estimate) | On the payslip |
| --- | --- | --- | --- |
| Ali Mohamed Ali Elsayed (A-12) | 5 | 6,183.86 | 0 |
| Omar Anwar Ibrahim Ahmed Gawish (B-10) | 3 | 1,693.56 | 0 |
| Mahmoud Ibrahim Ahmed Mohamed (A-1) | 4 | 620.97 | 0 |
| Samaa Mosaad Khalil (A-3) | 1 | 427.42 | 0 |

### 2026-08 · CRM — 19,798.39 EGP

`p1_crm` was confirmed **30 August 00:15** and `p2_crm` **8 September 10:12**; the decisions were
taken **4 September 18:24–19:13**. Here the draft's `crm` column holds an explicit **0.00**, not a
null — something wrote a zero.

| Person | Days | Owed (estimate) | On the payslip |
| --- | --- | --- | --- |
| Samia Ali Kasem Ali Gabr (CN-0003) | 18 | 7,983.87 | 0 |
| Sherouk Wael Khalaf Mohamed (B-34) | 13 | 5,564.52 | 0 |
| Soad Atef (AI-0003) | 8 | 3,991.94 | 0 |
| Gerges Sameh Khalil Mahwed (B-112) | 5 | 2,258.06 | 0 |

**Total fully missed: 28,724.20 EGP across 8 people.**

## Partially short — 7,723.58 EGP

The sheet carries a figure, but less than the sum of what was approved. None of these carries a
typed amount either, so the gap is not a reduction anyone entered.

| Month | Person | Approved | On the payslip | Short |
| --- | --- | --- | --- | --- |
| 2026-07 | Amr Mohamed Naguib Elsabey (B-122) | 3,091.94 | 750.00 | 2,341.94 |
| 2026-07 | Hossam Mohamed Reda AboElftouh (A-9) | 1,563.87 | 608.00 | 955.87 |
| 2026-07 | Nahed Tarek Hassan Omar Hattab (A-10) | 774.18 | 266.67 | 507.51 |
| 2026-07 | Youmna Mohamed Salaheldeen Ahmed Kotb (A-16) | 548.38 | 73.67 | 474.71 |
| 2026-08 | Ashraf Maged Mohamed Abdelhameed Radwan (B-179) | 3,250.00 | 290.32 | 2,959.68 |
| 2026-08 | Fiby Wagdy Luka (B-52) | 2,177.42 | 1,693.55 | 483.87 |

**Under-collected in total: 36,447.78 EGP.**

## Correctly absent — not misses

- **Six held rows, 10,556.45 EGP.** A held row is dropped at publish by design, and none of these
  six has a payslip in its month at all: Sameh Ahmed Ezzat Mohamed Hussien (B-157) 2,225.81 and
  Fiby Wagdy Luka (B-52) 967.74 in July; Engy Said Mohamed Elsayed (CN-0004) 3,104.84, Hayam Mohamed
  Eladl FaragAllah Hefnawy (B-25) 2,129.03, Ahmed Helal Eliwa Hussenin (B-3) 1,862.90 and Mahmoud
  Mohamed Hassan Eltanany (B-167) 266.13 in August.
- **Three approvals priced at zero.** Adel Srour (CN-0006) 6,919.35 → 0.00, Ahmed Hemdan (B-58)
  451.61 → 0.00 and Aisha Ehab (B-79) 483.87 → 0.00 in August were approved *with* an applied amount
  of zero. Nothing on the sheet is the correct outcome.
- **The remaining 48 groups were collected in full or above.** The payslip column carries the
  month's whole figure, not one candidate's, so a sheet value *larger* than one approval is normal —
  Mina Masoud Lamy Atta (B-124) 1,032.26 approved against 1,548.00 on the sheet, Nada Osama Nouby
  Hussein (B-152) 225.81 against 266.13, Walid Fathy Abdelfattah Shafek Mohamed (B-188) 500.00
  against 1,500.00.

🔴 **Sherouk Wael Khalaf Mohamed (B-34)'s July pair is NOT a miss.** Her July `crm` 967.74 and her
July `other` 967.74 both appear on the payslip at exactly those figures. Only her **August** CRM
charge of 5,564.52 was lost. An earlier pass had her July rows unresolved.

## What the timing says, and what it does not

In both months **every one of the lost decisions was taken after the step that owns its payslip
column had been confirmed** — the documented frozen-step gap, where confirming a step freezes that
module's figure and a later decision lands nowhere. That is the strongest available explanation and
it fits both months.

🔴 **It is not proven.** All eight draft rows have `source = inline`, `edited_by = B-10` and
`write_step_key = null` — their last write was a hand edit on the screen, not a connector step
(July: 8 August 13:22–13:45, two days before publish; August: 8 September 14:09, 34 minutes before
publish). So the column was null or zero at publish, but the final writer was an inline edit, and
this sweep cannot say whether the connector computed a figure that was then overwritten or never
wrote one at all.

The resync path that re-applies a decision taken after a confirm is
`src/lib/automated-payroll/deduction-resync.ts`; `payrollStepsForCategory` there is the mapping from
category to draft column, branched on `settled_in_part1` — which is **null** on all eight rows, so
`crm` resolves to `p2_crm` and the plain `crm` column.

## Nothing here is changed by a session

Both months are published, production has **no PITR**, and a correction is money. Whether any of
this is carried forward is decided on the Automated Payroll screen and
`/admin/deductions` — not in chat, and not by a write from here.

## The mirror defect, on the OPEN month: a charge the module never proposed (2026-10-09)

Everything above is a deduction the module approved that reached the payslip as **0** — money the
company did not collect. This is the opposite direction, found the same week on the **open**
September 2026 run (`6b941989-9f31-49f1-830b-31edc0e8f374`, Part 1 confirmed 2026-10-09 03:33
Cairo): a column charging money the module proposes **nothing** for.

Audited across all 104 rows and the five payroll buckets — 520 figures, of which 513 match the
module exactly:

| Who | Column | Run charges | Module approved | Candidates |
| --- | --- | --- | --- | --- |
| Nahed Tarek Hassan Omar Hattab (A-10) | Part 1 Other Deductions → Other | 2,931.00 | 0.00 | **none in the month** |
| Hossam Mohamed Reda AboElftouh Abdelghafar (A-9) | Part 1 Other Deductions → Other | 400.00 | 0.00 | **none in the month** |
| Ghada Mohamed Abdelwahab Ismaiel (B-189) | CRM | 483.33 | 241.67 | 1 approved half day |

A-10 and A-9 are the same lateness charged **twice**. Their Fingerprint column is correct and
module-backed — A-10 at 2.75 days / 2,933.32 (six approved candidates, each locked) and A-9 at
0.26 days / 400.00 (two approved of seven) — and the Other column repeats it. Neither has a single
`other`-category candidate in September, live or superseded, so not a piastre of the Other figure
has an approved deduction behind it. Both figures predate the cell history (which begins
2026-10-07), so nothing records who wrote them; the `p1_other_deductions` confirm at 01:32:25 wrote
`0.00` for every other employee on the step and left these two alone, because `pick(draft,
recommended)` prefers the saved figure.

### Why no existing check saw it

`detectModuleDrift` asked one question: *has the module changed its mind since the confirm?* With
the module proposing 0.00 at the confirm **and** 0.00 now, the comparison had nothing to compare and
returned early — before it ever looked at what the row actually charges. So the figure was invisible
to the drift report, to the Part 2 gate (which only blocks on `staleCharges`), and to
`takeCurrentModuleFigures`, whose remedy is a re-confirm that `pick` makes a no-op anyway.

Closed by `isUnbackedCharge` (`src/lib/automated-payroll/module-sourced-steps.ts`, browser-safe and
re-exported by `module-drift.ts`) and the new `unbackedCharges` count, pinned by
`tests/automated-payroll-module-drift.test.ts`. It is **reported, never blocking and never
rewritten**: HR may enter a manual deduction straight onto a step with no candidate behind it by
design, so such a figure can be perfectly deliberate, and only `chargeSource` from the cell history
can say who set it. B-189's CRM gap is a different shape — the module does propose 241.67 there — and
is covered by the existing stale-charge path.

Four figures run the other way on the same run and are **not** defects to sweep: B-79 CRM 1,250.00
against 1,450.00 approved, AI-0021 vacation 258.33 against 516.67, B-189 vacation 483.33 against
966.66, A-7 vacation 0.00 against 733.33. B-189's was reduced from 966.66 by hand at 2026-10-09
07:58 Cairo and is a decision, not drift.

Correcting any of it is money on an open run: it is decided on the Automated Payroll screen, not by
a write from here.

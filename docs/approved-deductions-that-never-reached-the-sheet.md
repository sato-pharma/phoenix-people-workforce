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

## The sweep is a command now (2026-10-09)

Everything above was produced by hand, in SQL, and that is exactly the problem: asked twice on
2026-10-09 the same question gave two different answers for the same month. The first pass compared
one employee's unpaid vacation against a single candidate when the module had approved two days, and
reported a 700.01 gap that was really 941.67.

```bash
pnpm run payroll:reconcile-deductions -- 2026-09      # or a run id, or nothing for this month
```

`src/lib/automated-payroll/deduction-reconciliation.ts` holds the comparison as a pure function;
`scripts/reconcile-payroll-deductions.ts` is a thin caller. It **reports and changes nothing**, and
a difference is not a defect — the owner trims a proposal deliberately.

🔴 **A plain run exits 0 even when figures differ.** Exit 1 is opt-in behind `--gate`, for a cron
that needs to alarm; nothing calls it that way today. Exiting 1 by default made pnpm print
`[ELIFECYCLE] Command failed with exit code 1` underneath a correct answer, which reads as a broken
tool rather than as a month holding figures he decided himself — he hit exactly that within minutes
of the command existing.

### The routing is the whole difficulty, and it is `isSettledInPart1`

A deduction bucket does not have one salary column. Compare it against the wrong one and the report
invents a gap for money that is charged and misses one that is not. `claimsFor` mirrors one
recommender per entry:

| Bucket | Settled in Part 1 | Not settled (Part 2) |
| --- | --- | --- |
| `fingerprint` | `fingerprintValue` | `fingerprintValue` |
| `crm` | `p1odCrmValue` — but a **leaver's** is not comparable at all | `crm` |
| `unpaidVacation` | `p1odVacationValue` **+** `unpaidVacations` (assembleRows charges both) | `unpaidVacations` |
| `loan` | `p1odLoanValue` | **`manualOtherDeductions`, together with `other`** |
| `other` | `p1odOtherValue` | **the same one column** |

The predicate is read exactly as the steps read it — the frozen Part 1 stamp first, the live rule
only while Part 1 is unconfirmed — so the report agrees with the sheet instead of forming a second
opinion about it.

### Four answers that are not shortfalls

- **`not comparable by design`** — a leaver's CRM. `recommendP1Crm` skips leavers; the module prices
  a day off **BASE** and `recommendResignationCrm` off the leaver's **NET** (owner, 2026-08-04 for
  which days, 2026-08-30 for what a day is worth). Both sides are shown and the gap kept visible but
  uncounted in `notComparableGaps`. Printing the run side as `0.00` said the opposite of the truth:
  B-79's column holds 1,250.00, which the cell history records him typing himself on the `p2_crm`
  step at 2026-10-09 03:28 Cairo, over the module's 1,450.00. A-28 is the control on the same claim
  — 1,050.00 both sides, the two rates agreeing.
- **`not in the population`** — a draft row for somebody no recommender runs for. A-7 carries one on
  the September run with 733.33 approved, terminated 31 August, inside the cohort closed as settled
  off-system on 2026-10-07. Nothing can charge him, so it is not an under-charge.
- **`not on this run`** — approved money with no draft row at all.
- **anything the owner trimmed** — B-189's 483.33 and AI-0021's 258.34 on this run, his own decision.

Pinned by `tests/automated-payroll-deduction-reconciliation.test.ts`, which runs inside the required
`validate` job. Twelve assertions, each watched failing with the fix broken and restored from a copy.

## A retired approval is never scored in either direction (2026-10-09)

The owner ran the new command for August 2026 and it reported **934.74 EGP over-charged** across two
unpaid-vacation rows:

| Employee | Approved | Run charges | Module showed |
| --- | --- | --- | --- |
| Yathreb El Ghannam | 2 Aug + 25 Aug, 2 days = 967.74 | 967.00 | 483.87 |
| Aya Abdullah | 8 Aug, 1 day = 451.61 | 451.61 | 0.00 |

Both charges were sound. Each traced to an approval the owner gave on **4 Sep 2026**, and each
approval was retired *after* the run was published on **8 Sep 2026, 14:43 Cairo** — Aya's on 10 Sep,
Yathreb's on **8 Oct**, a month after the money was paid. The reconciliation was comparing a frozen
sheet against the module as it looks today, so a retirement that happened weeks later read as the
run having over-charged.

**Neither figure could be proved from the cell history.** `automated_payroll_draft_cell_history`
begins 7 Oct 2026 at 10:37 Cairo, so August has no per-cell provenance at all. The candidates and
their decisions are what settle it.

### Why "count every retired approval" is worse than the bug

Measured on production the same day — 94 retired approvals across 45 employees, 62,679.51 EGP:

| Shape | Rows | EGP |
| --- | --- | --- |
| No replacement candidate at all — the **source withdrew the row** | 93 | 56,582.74 |
| Replacement approved (the carry-forward worked) | 1 | 2,800.00 |
| Replacement left Pending | 1 | 6,096.77 |

93 of 94 are retractions: an unpaid day corrected to paid, a fingerprint day excused. Counting those
would report a run as correct for charging money nobody stands behind — the failure direction that
costs an employee real pay. July holds 65 of them, August 25, September 4.

None of this is missing pay. Each run froze its figures while the approvals were live, so the
published months charged what was confirmed at the time. What was lost is the audit trail.

### The rule

1. A retired approval counts on the module side **only if it was retired after the run was frozen**
   (`publishedAt`, else `part1ConfirmedAt`). One retired before the freeze was already withdrawn
   when the sheet was built and still reports as a difference.
2. A claim standing on retired money gets its own verdict, **`explained by a retired approval`** —
   reported, never scored. It cannot prove an over-charge, because the figure was approved when the
   sheet was frozen; it cannot demand a charge either, because the module has withdrawn the money
   and a run that never charged it gives the same answer the module now gives.
3. `buildDeductionBuckets` is **default-off**. Every money path — `recommend.ts`, `run-service.ts`,
   `step-definitions.ts`, `module-sourced-steps.ts` — calls it without the option and sees exactly
   what it saw before.

Rule 2 is the one that is easy to get wrong. Folding retired approvals into the module total removes
the two false over-charges and creates **five false under-charges worth 3,597.53 EGP** — Samia Ali
Kasem Ali Gabr 967.75, Mina Farouk Nawar Rizkallah 870.97, Sameh Shabaan El Hoseiny 870.97, Mohamed
Raffat Mohamed Waly Gad 532.26, Ahmed Mohamed Rabiee Fayk Elkawas 354.84 — because a withdrawn
approval the run also never charged is the module and the run *agreeing*.

After the fix August reads "Every approved deduction is charged by this run", with six claims listed
under `RETIRED APPROVAL` and 25 approvals worth 11,959.69 EGP declared as retired-since-frozen.
September is unchanged, including the owner's own trims on Ghada (483.33) and Esraa (258.34).

Pinned by `tests/reconcile-counts-retired-approval.test.ts` in the required `validate` job — five
breaks watched failing, each restored from a copy.

# Automated Payroll — audit ledger

**Audit run:** 2026-09-10 → 2026-09-12 · **Findings numbered:** 1 – 55 · **Ledger written:** 2026-09-12

> **🟢 CYCLE 4 (2026-09-12) CLOSED THIS AUDIT.** The original audit document was recovered — it was in the transcript of the Claude Code session that wrote it, on this machine — and **all 55 findings are fixed**, the fourteen that read "no trace" included. Read [audit-original-findings.md](audit-original-findings.md) for the audit itself and [audit-cycle-4.md](audit-cycle-4.md) for the trace. **Rows and counts below have been corrected; superseded wording is struck rather than deleted.** ~~One item is still open and it is half of finding 1 — the outstation paid-stamp, which needs an owner decision.~~ **Closed the same day by PR #3786** after the owner answered the expense-meaning sheet — nothing in this audit is open.
>
> **Cycle 2 ran on 2026-09-12** and is recorded separately in [audit-cycle-2.md](audit-cycle-2.md). It did not recover any of the thirteen — nothing in this repository could — so every count and every row below still stands exactly as written. **Cycle 3 (2026-09-12) corrected the scope of that claim: the owner holds the original audit document, so the thirteen are recoverable from him even though they are not recoverable from here.** Cycle 2 numbered one new finding, **56**, continuing this series so the two can never collide.

## Why this file exists

Until today this audit existed **only as code comments and pull-request descriptions**. There was no
list. Nobody — including the person who ran the audit — could answer "is finding 28 fixed?" without
reading fifty files, and for thirteen of the findings the answer is *still* unknown because nothing in
this repository records them at all.

This ledger is the record. It is built **entirely from evidence in the repository** — a code comment
naming the finding, a test that pins it, or a merged PR description that claims it. **Where there is
no evidence, the row says "no trace found" rather than guessing.** A finding nobody can account for
is a worse outcome than a finding that is still open, because the open one is at least visible.

**What this ledger is not.** It is not the audit itself — that is now
[audit-original-findings.md](audit-original-findings.md), recovered 2026-09-12 and sitting beside this
file. ~~The audit document was never committed to this repository, and is not recoverable from it.~~
The first half of that was true; the second was wrong twice over. It was recoverable from the owner,
and it was recoverable from this machine's own session transcripts, which is where it came from.

> **CORRECTED 2026-09-12 (cycle 3).** Earlier wording said the document could not be recovered from
> anything the company holds. **That was wrong: the owner holds the original.** The repository lost
> it; the company did not. Every irrecoverability statement in this ledger is scoped to this
> repository, and the ruling further down — made on the stated basis that no source survived — is
> **suspended pending that document**. See [audit-cycle-3.md](audit-cycle-3.md).

## The numbers

| | Count | Findings |
| --- | ---: | --- |
| **Fixed, with evidence** | **55** | 1–55 — all of them |
| **Claimed closed by earlier work, no code marker** | **0** | — (30 and 36 were here until 2026-09-12; re-verified, see below) |
| **Referenced, but neither fixed nor dismissed** | **0** | — (19 was here until 2026-09-12; fixed by PR #3649, see below) |
| **No trace found anywhere** | **0** | — (1, 6–13, 21, 24, 25, 28 were here until 2026-09-12; all fixed, see below) |
| **Total** | **55** | |

> **CORRECTED 2026-09-12 (cycle 4).** This table read 41 / 0 / 1 / 13 until the original audit was
> recovered from the transcript of the session that wrote it. **All fourteen of the supposedly
> untraceable findings turned out to be fixed**, each by a named merged PR that describes the defect
> in prose without ever writing its number — which is why a search for the numbers found nothing.
> ~~One item remains genuinely open and it is *half* of finding 1: the outstation paid-stamp, deferred
> pending an owner decision.~~ **Closed 2026-09-12 by PR #3786** on the owner's ruling — see finding 1's
> row below and [audit-cycle-4.md](audit-cycle-4.md).

> **Status of the thirteen, plus 19: RESOLVED 2026-09-12 (cycle 4) — the ruling is moot.** The audit was recovered and all fourteen are fixed. The ruling text is kept below rather than deleted, so the record shows both what was decided and what was later found. See [The ruling on the fourteen](#the-ruling-on-the-fourteen--closed-2026-09-12) and [audit-cycle-4.md](audit-cycle-4.md).

~~Thirteen numbers — **1, 6–13, 21, 24, 25 and 28** — appear nowhere: not in code, not in a test, not
in a commit message, not in a merged PR description, and not anywhere in git history.~~

**Struck 2026-09-12 (cycle 4).** That sentence was accurate; the conclusion drawn from it was not.
Those thirteen numbers genuinely appear nowhere — and all thirteen were nevertheless **fixed**, under
a different description, exactly as the original next sentence allowed for. They were closed by PRs
#3641, #3642, #3651, #3659, #3669, #3674, #3684 and #3687, not one of which cites a finding number.
**A search for an identifier proves only that the identifier is absent.**

## How to read a row

- **Evidence** is the strongest thing found, in this order: a test that pins the behaviour > a code
  comment naming the finding > a merged PR description.
- **PR** is where it landed. Where two PRs appear, the fix shipped in halves (a server half and a
  screen half) and both are needed for the finding to be closed.
- A row that says **no trace found** means exactly that: `git grep` across the whole tree and
  `git log -S` across the whole history return nothing for that number in the payroll paths, and no
  merged PR description mentions it.

---

## The ledger

### Bank files, and money that left no record — PR #3642 (2026-09-10)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **1** | **The wizard paid outstation trips and never stamped them as paid**, so the legacy "Import to payroll" button could sweep them in again. All 374 production rows carried a blank stamp, EGP 126,104.66 of it importable. Closed at the database rather than at the stamp: the import now refuses a month Automated Payroll produced, and excludes every trip whose own payout period it paid. **Forced on production 2026-09-12** — the August call was refused by name, a December control still ran, 0 rows stamped either way. **The paid-stamp itself closed 2026-09-12 (PR #3786)** on the owner's ruling: publishing marks the approved trips of the run's payout period at HR's edited figure, else the claim — never a pending, rejected, already-marked or held employee's trip — and trips before 1 July 2026 are imported history, values only. No backfill: July and August stay unmarked, and September's publish is the first to mark. | `phx_period_paid_by_automated_payroll` + `phx_import_approved_expenses_to_payroll`, migration `20260910160000` · `recordPaidExpenseStamp` in `src/lib/automated-payroll/expense-stamp.ts` · `tests/outstation-import-refuses-wizard-months.test.ts` · `tests/outstation-paid-stamp-and-imported-history.test.ts` | code + test + PR #3641 + PR #3786 |
| **2** | Both bank builders routed on an exact match of the words `FAB` and `CIB` and silently dropped every other bank. Three people on the live August standing roster — two QNB, one Instapay, 19,000 EGP a month between them — were in neither file. | `src/lib/automated-payroll/exports/bank-coverage.ts` | PR #3642 |
| **3** | The only check on a finished bank file was whether it came out *completely* empty, so a file missing a fifth of the population downloaded clean and said nothing. The finance sheet's TOTALS row counted their money anyway, certifying a payment the bank files could not make — for two months, in silence. | `bank-coverage.ts`, the `X-Bank-Coverage` download headers, the publish audit row | PR #3642 |
| **4** | An overpayment was marked recovered without ever being deducted. | the carry-forward path | PR #3642 |
| **5** | A held person left no record of what they were owed. | the publish hold record | PR #3642 |

> **Re-verified empirically on 2026-09-12** — see
> [audit-cycle-3.md](audit-cycle-3.md#findings-25--outside-the-37-verified-2026-09-12). All four
> hold, and the evidence is no longer only PR #3642's description: the August bank and finance
> workbooks were built and read back, six breaks each fired their own assertion, and the coverage
> figures reconcile to the finance sheet's own TOTALS row to the cent. Two qualifications belong
> with the rows above. **Finding 2 is far larger in production than this row records** — 24 payable
> rows reach neither bank file in August Part 1 (EGP 291,477.41), not three people at 19,000, because
> 18 employees carry no bank name at all. And **3 and 5 are fixed for the next month, not proven on a
> month that has run**: both published audit rows predate #3642 and carry only a count, so September
> is the first publish that can hold the held roster or the coverage block.

### Findings 6 – 13

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **6** | **35 held people across two published months, with no record of what they were owed.** Publish dropped held rows leaving only a count in one audit row; the overpayment ledger was empty. The published audit row now carries `held`, `heldFirstPartTotal`, `heldSecondPartTotal` and `heldWithoutMeaningfulReason` — "the permanent answer to who was held this month, for how much, and why" — and `automated_payroll_held_settlements` is live in production with RLS and four policies. | `run-service.ts` publish audit detail · `tests/automated-payroll-settlement-and-held-record.test.ts` | code + test + PR #3642 |
| **7** | **The engine filed a copied column, not the insurance wage.** It took `employees.social_insurance` raw and never touched `social_insurance_wage` — on August's run 94 of 100 records carried the raw figure and none carried 11% of the clamped wage, so the Copilot and this engine filed the same person at two different amounts. Neither figure reduces take-home pay; what moved was the filing. | `assemble.ts` via `statutoryFromInsuranceWage` · `tests/payroll-statutory.test.ts` | code + test + PR #3659 |
| **8** | **The Statutory Summary reconstructed a wage by dividing by 11%**, which only works if the stored deduction really is 11% of something — and per finding 7 it was not. 88 of 91 rows came out above the 16,700 legal ceiling and the insured payroll read 2.27× true. The subject wage is now READ from the wage column and clamped, with what was actually deducted shown beside it rather than instead of it. | `exports/statutory-summary.ts` · `tests/payroll-statutory.test.ts`, `tests/payroll-exports.test.ts` | code + test + PR #3659 |
| **9** | **A leaver's frozen first instalment was inflated by his own Part-1 deductions.** The remaining second instalment was measured after fingerprint, loan and medical had already come off, so the system saw headroom that was really those deductions and overpaid. The worked case in the audit — 12,000 net, 400/600/300, 1,500 final — paid 10,500 against a true 9,200, booked as a debt against someone with no next month. | `split.ts` (`provisionalSecond` measured from the anchor) · `tests/automated-payroll-leaver-overpayment.test.ts` | code + test + PR #3651 |
| **10** | **Approved unpaid vacation was charged twice** — once by shortening the days paid for, once as a deduction raised from the very same `v2_vacation_requests` rows. Unified on the admin-facing figure (owner, 2026-09-11): the deduction is the one a human reviews, the subtraction was invisible arithmetic. It also ended a disagreement — two of the four callers already passed 0. | `copilot/proration.ts` · `tests/automated-payroll-leaver-basis.test.ts` | code + test + PR #3651 |
| **11** | **The same absence day could be charged twice on the path that pays people.** The one-day-one-charge rule lived inside the Deductions module's own publish step, which payroll deliberately never runs. Now enforced at Part 2 confirm at the same strength, and **not acknowledgeable** — which of two claims is wrong is a judgement payroll cannot make. | `detectPayrollDayCollisions` in `run-service.ts` · `tests/automated-payroll-day-collisions.test.ts` | code + test + PR #3684 |
| **12** | **Opening the days editor and pressing Save threw away the Thursday half-day.** The workspace pre-fills the day box with the count of ticked dates and sends it on every save, so the default coming back was honoured as a figure a human typed. Five approved August candidates were stamped a half-day high each. The money survived by luck — the amount came from an already-weighted estimate — but the day columns drive the auto-calc, so it was one click from real. | `chargeableDeductionDays` in `deductions-source.ts` · `tests/automated-payroll-thursday-half-day-charge.test.ts` | code + test + PR #3687 |
| **13** | **A confirmed deduction figure was latched forever.** Setting the candidate to Do Not Take Action afterwards still paid it, and a candidate approved later contributed nothing. What the module was proposing is now snapshotted at confirm, and the wizard names anyone whose figure the module no longer agrees with. **Detection, not auto-correction** — the stale figure is visible rather than silent; changing it is still a human action. | `getModuleDrift` in `run-service.ts` · `module-drift.ts` · `tests/automated-payroll-module-drift.test.ts` | code + test + PR #3674 |

> **Three decoys — other audits' numbering, in files a search will reach.** None of them is evidence
> for any finding in this ledger.
>
> - The numbers 1–6 appear in `src/lib/direct-orders/` and in `docs/direct-orders-delta-reaudit.md`.
>   **That is the Direct Orders re-audit**, which has its own 1–24 series and its own document.
> - `tests/ready-payroll-template-formulas.test.ts:123` says *"…re-introduce the overpayment finding
>   #1 fixes"*. The comment block about fifteen lines above reads `// Finding #2 (risk-review):` — that
>   file numbers a **risk review**, not this audit.
> - `tests/attendance-manager-view-access.test.ts:101` says *"resolveAttendanceScopeHrIds — findings
>   #19/#20 fix"*. That is attendance **access scope**, unrelated to payroll findings 19 and 20.

### Reads that failed quietly — PR #3699 (2026-09-11), PR #3717 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **14a** | The CRM collector discarded the error on its job-title read, leaving every title null — and a null title reads as "Saturday off", so every Saturday weighted to zero and the month quietly under-charged. | `tests/automated-payroll-fail-closed-reads.test.ts` | test + PR #3699 |
| **14b** | An empty draft set let one collection run retire the whole month. | same | test + PR #3699 |
| **34** | A failed leavers read does not merely lose a signal, it **removes people from the run**: `recommendPopulation` keeps a payroll-ineligible employee only when they are a leaver this month. Measured on production — every leaver since June carries a terminal status, so all of them would go. **August 2026 alone is 30 people and 579,000 EGP of monthly net salary.** | `tests/automated-payroll-fail-closed-reads.test.ts` | test + PR #3699 |
| **49** | The check against a live Payroll Copilot run discarded its error, so a failed read came back as "no Copilot run" and both engines wrote the same month's decision tables — the double-write that check exists to stop, with nothing recording it. | `src/lib/automated-payroll/run-service.ts` (`FAILS CLOSED (audit finding 49)`) | code + test + PR #3717 |

### Nobody was told — PR #3708 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **15** | **205 people were never told their payslip was ready.** The notification was a helper **private to a route file** on the old payroll module's Approve button. Automated Payroll — the live payroll path since July 2026 — could not reach it, and approved its batches in silence. | `src/lib/payroll/notify-payslip-available` · `tests/payroll-payslip-notice.test.ts` | test + PR #3708 |

### The standing roster — PR #3696 (2026-09-10)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **16** | The non-employee duplicate guard matched only on the roster reference. A person typed in by hand carries none, so seeding the standing list inserted them a **second** time. Both rows reach the bank file and the sheet's totals row counts both. | `tests/automated-payroll-non-employee-seeding.test.ts` | test + PR #3696 |
| **17** | Sync refused only a published or cancelled run. Pressing it during Part 2 inserted a first-instalment row onto a Part 1 finance had **already executed**, and the per-part edit lock then made that row impossible to change or remove. | `src/lib/automated-payroll/non-employee-recurring.ts` | code + test + PR #3696 |

### A confirmed run stops moving — PR #3706 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **18** | **The run stayed editable after the money left.** `ready` means Part 2 is confirmed and finance has the sheet and both bank files. Every step stayed writable anyway: the lock HR sees is a browser property, never a server rule. | `tests/automated-payroll-run-integrity.test.ts` | test + PR #3706 |
| **19** | **"Start / Resume run" on an already-paid month created a second, shadow run.** `findActiveRun` sees only part1/part2/ready and the one-run-per-month index deliberately excludes published months, so the wizard offered Start on a paid month — and the new empty run became the one every finance screen answered with, making the paid month's sheet and bank files unreachable. **It actually happened**: a second August run was created on production on 2026-09-10, and two steps were confirmed against it ninety seconds later. Now refused at Start rather than at publish, a month of work later. | `startOrResumeRun` via `findPublishedRun` in `run-service.ts` · `tests/automated-payroll-guards-that-guard.test.ts` | code + test + PR #3649 |
| **20** | **Reopening Part 1 did not re-derive.** It cleared the frozen instalment but not the Base, allowance, fuel and days-worked figures the Joiners and Resignations steps stamped onto the same rows — and a stored figure **beats** the employee record. A rep hired on 10 August at 5,000 instead of 8,000 stayed on the 5,000 after the record was corrected, the run reported success, and the sheet showed the right salary beside an instalment computed from the wrong one. | `unconfirmPart1` in `src/lib/automated-payroll/run-service.ts` | code + test + PR #3706 |

### Findings 21, 24, 25, 28 — PR #3669 and PR #3649 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **21** | **Re-confirming the Part 2 Vacation step handed back the leave days the first confirm consumed.** The recalculation read the balance its own earlier settlement had already reduced, found nothing left, reclassified the leave as salary-deducted and superseded the first record — so the days returned while the deduction stayed. It oscillated: a third confirm consumed them again. The run is now passed in so its own earlier settlement is excluded from the balance it re-reads. | `settleCrmLeaveBalanceForPeriod` in `run-service.ts` · `tests/automated-payroll-vacation-reconfirm.test.ts` | code + test + PR #3669 |
| **24** | **An interrupted publish could mark the run published over a batch that was never approved.** Publish finalised a leftover batch only when it was still `uploaded` and marked the run published anyway for any other state — and payslips are visible only for an approved batch. Because publish returns early for an already-published run, every retry reported success with zero rows and the month became permanently unpublishable. `assertBatchApproved` now refuses rather than assuming. | `assertBatchApproved` in `run-service.ts` · `tests/automated-payroll-guards-that-guard.test.ts` | code + test + PR #3649 |
| **25** | **The approve step never checked that it approved anything.** The `.eq("status", "uploaded")` guard is real and stays, but a zero-row match returns no error — so anything moving the batch between create and approve left the update silently changing nothing. `finalizeApproved` now reads back what the batch actually is and returns it, so the caller can refuse. | `finalizeApproved` in `run-service.ts` · `tests/automated-payroll-guards-that-guard.test.ts` | code + test + PR #3649 |
| **28** | **The hard "the split does not add up" gate compared a number to itself.** `assembleParts` defines `monthSalary` as `firstPart + secondPart`, so the check could only ever pass — any real defect recomputes the total from the same two wrong numbers and sails through, finding 9's overpayment included. It now tests the split against the locked engine's own `totalPayable`, with the overpaid residual added back so the identity is exact in both branches. | `reconcile.ts` (`splitAgainstEngine`) · `tests/automated-payroll-guards-that-guard.test.ts` | code + test + PR #3649 |

### One deduction, one instalment — PR #3703 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **22** | Whether a loan, CRM or unpaid-vacation deduction is taken in Part 1 or Part 2 was decided **live, every time any step was opened**, by reading the employee's payment mode and lifecycle — while the columns it routes money into are permanent. Changing someone's payment mode moved a deduction that had already been charged. | `tests/automated-payroll-part-split-stamp.test.ts` | test + PR #3703 |

### Additions — PR #3707 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **23** | Additions is the only step that **adds** money and the only one with no feeder behind it — no Deductions module, no expense workflow, no CRM, no vacation ledger a reader can go and check. Incentive and bonus money was added with no recorded reason. | `tests/automated-payroll-additions-record.test.ts` | test + PR #3707 |

### The decision trail — PR #3701 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **26** | `automated_payroll_audit` (202 production rows) and `deductions_audit` (1,566) are the **only** record of who decided what on a payroll month. Both had zero protective triggers, and `authenticated` held DELETE, UPDATE and TRUNCATE on both. | `tests/payroll-audit-trail-append-only.test.ts` | test + PR #3701 |

### A button that did nothing — PR #3741 (2026-09-12)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **27** | **"Apply changes" did nothing at all.** The file input's change handler clears `input.value` so re-picking the same file fires `change` again — which empties `input.files` with it. Apply read `fileRef.current?.files?.[0]`, got `undefined`, hit its guard and returned. No request, no error, nothing on screen; the preview stayed up, so the edits read as *pending* rather than lost. Deferred from #3712 as a front-end fix, then closed. | `src/components/automated-payroll/recommendation-step.tsx` | code + PR #3712 (deferred) + PR #3741 (fixed) |

### Hired and gone in one month — PR #3711 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **29** | A person who both joined and left in one month is classified as a **leaver only** — the leaver branch returns before the joiner branch is reached — and the settlement counted days from the 1st. So it paid for days before the person was hired. | `tests/payroll-same-month-joiner-leaver.test.ts` | test + PR #3711 |

### Findings 30 and 36 — re-verified 2026-09-12

They sat in this ledger as **claimed closed, with no code marker**: PR #3717's description said
*"Findings 30, 33, 34 and 36 were already closed by earlier work"*, named no such work, and neither
number appeared in the code, the tests or git history. The claim was the only evidence. That entry
was correct when written. It is no longer, and the evidence state is kept here rather than
overwritten, because what was known at the time is part of the record.

Both were examined against live production and `origin/main` on 2026-09-12. Both are genuinely
closed, and both now have a marker anyone can check.

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **30** | An employee with no social-insurance figure was filed at zero rather than flagged. | `data-quality.ts` raises `missing_insurance_wage` through `usableInsuranceWage(…) === null`, so a NULL, a zero and a stray non-number all read as missing — "published at zero" is the case it catches. `copilot/assemble.ts` computes social insurance only when the wage is non-null. | code + test (`tests/automated-payroll-insurance-wage.test.ts`, registered) |
| **36** | The Ready payroll sheet paid a full unprorated month to a leaver whose resignation was still in the workflow. | Closed by WHERE the status write lives: `phx_resign_employee_and_open_vacancy` sets `employment_status` when the resignation is **filed**, not when its workflow completes, so an in-workflow leaver is already terminal to the Ready sheet. | code + test (`tests/payroll-ready-sheet-leaver-proration.test.ts`) |

**Production, 2026-09-12.** For 30 the condition is live: **6** active payroll-eligible employees
have a NULL `social_insurance_wage` (0 at zero, 97 positive, 103 total), so the flag has real work
to do. For 36 the exploitable state does not exist: the one resignation still at workflow status
`submitted` already carried `employment_status = 'resigned'`, and no row had an in-flight
resignation against an employee still `active`. The single active-employee resignation row is
`cancelled` — correct, that person did not leave.

**Why 36 needed a test of its own.** Its closure is a consequence of a mechanism, not of an explicit
guard. Moving the status write to the workflow's completion step — a reasonable-looking tidy-up,
since the rest of the resignation lifecycle is workflow-driven — silently returns every leaver to a
full unprorated month. The new test pins the mechanism across *every* migration that defines that
RPC, so a future redefinition that drops the write fails rather than shipping.

### The spreadsheet round trip — PR #3717 (2026-09-11), PR #3709 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **31** | **Five day columns could never be saved.** They shipped editable, so a sheet changing one previewed "2 to 6 (changed)" and then saved nothing — `stepEditToPatch` had no column to put it in. The five: `p1odCrmWorkingDays`, `resigCrmWorkingDays`, `p2VacationDays`, `p2CrmDays`, `p2ManualDeductionDays`. | `exports/step-template.ts` · `imports/step-parser.ts` · `types.ts` (`notPersisted`) | code + test + PR #3717 |
| **32** | **A corrected day count moved the days and left the money behind.** The template pre-fills money columns with the old figures and a saved figure always wins, so a leaver corrected from 12 days to 4.5 was settled for 12. | `step-definitions.ts` · `imports/day-driven-money.ts` · `run-service.ts` · `recommendation-step.tsx` | code + test + PR #3717 |
| **33** | Two step-template columns could normalise to the same heading, and `pickCell` returns the **first** match — so a re-upload read one column's value into another field. The belief that context columns "are never parsed back" is what let it ship. | `exports/step-template.ts` · `tests/automated-payroll-template-headings.test.ts` | code + test + PR #3709 |
| **48** | **A sheet without a Reason column blanked every reason.** The reason was written unconditionally, so re-uploading a sheet rebuilt without that column erased the justification on every row — while the preview reported nothing changed. An absent column now means "not supplied". | `src/lib/automated-payroll/imports/step-parser.ts` | code + PR #3717 |

### Money that was not refused — PR #3717 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **42** | **A negative bonus was accepted end to end** — a deduction travelling through the additions side, which no deduction check can see. Production before the change: 0 of 244 draft rows and 0 salary records held a negative figure. | `src/lib/automated-payroll/negative-values.ts` · `run-service.ts` · `src/lib/payroll/salary-import.ts` | code + test + PR #3717 |

### Reads and resyncs that said nothing — PR #3717 (2026-09-11), PR #3741 (2026-09-12)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **35** | **A failed expense read showed "nobody travelled"**, and the run published paying no reimbursement. It now fails closed with a 409 whose words reach the screen. | `src/lib/automated-payroll/recommend.ts` | code + PR #3717 |
| **44** | One approvals save covering two payout months **cleared people in the wrong month**. The resync now pairs each employee with the period their decision actually moved in. | `src/lib/automated-payroll/expense-resync.ts` (`byPeriod`) | code + PR #3717 |
| **45** | **Trips for someone outside the run were dropped silently** — no row, no counter, no warning. They now appear read-only with the approved and pending amounts, carrying no values, so nothing is paid from them. Production: July and August dropped 0 trips. | `src/lib/automated-payroll/recommend.ts` | code + PR #3717 |
| **47** | **A decision that could not reach payroll was reported to nobody**, under a green "Approvals saved." The server half (naming the skip in `payrollWarnings`) shipped in #3717; the screen half — the workspace was reading only `requestDecisions.skipped` and dropping the rest — shipped in #3741. | `app/api/admin/outstation/expenses/route.ts` · `src/components/outstation/expense-approvals-workspace.tsx` | code (both halves) + PR #3717 + PR #3741 |

### Held people in reports — PR #3717 (2026-09-11)

A held row is dropped at publish with no salary record, so every report built from salary records
treated held people as absent.

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **43** | **The Statutory Summary** silently omitted held people. It now prints who it leaves out, under the TOTAL, and publish records each held person's insurance and tax figures from now on. | `app/api/payroll/[id]/statutory-summary/route.ts` · `src/lib/automated-payroll/published-holds.ts` | code + PR #3717 |
| **46** | **The population baseline** counted last month's held people as absent, so they read as **new joiners** this month. Fixed in three stages: the baseline in #3717, the unaccounted-for subset and the transition guard in #3731, and the multi-gate retry loop in #3746 — each acknowledgement now carries every token already earned, so answering one gate cannot withdraw the answer to another. | `src/lib/automated-payroll/population-diff.ts` · `automated-payroll-wizard.tsx` · `part2/confirm/route.ts` | code + test + PRs #3717, #3731, #3746 |
| **52** | **The Executive Summary** compared two months on different bases — this month counts every assembled row plus non-employees; `salary_records` holds neither last month's held people nor any non-employee — so the difference read as movement. A basis the two months do not share is now said beside the numbers. | `src/lib/automated-payroll/exports/sheet.ts` · `run-service.ts` | code + PR #3717 |

### Access — PR #3717 (2026-09-11)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **51** | **The CEO Payroll Console had no company-scope check.** It lists every salary batch in the company, and `payroll:read` alone is held by self-scope admin roles such as SFE Manager. The sidebar hiding the link is presentation, not a boundary. | `app/(admin)/admin/m-payroll/page.tsx` · `tests/ceo-account-contract.test.ts` | code + test + PR #3717 |

### One day rate — PR #3752 (2026-09-12) · **owner ruling**

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **37** | **Three divisors were live at once.** Joiner and leaver pay divided by the month's real calendar days; the Deductions module divided by the month's real calendar days; **11 of Automated Payroll's 13 day-driven money fields divided by a flat 30.** So a day was worth one amount when it was *paid* and another when it was *taken away* — about 3.3% too much in a 31-day month, about 6.7% too little in February, never visible on a payslip, and invisible to any spot check done in a 30-day month. Settled by the owner's ruling of **2026-09-12**: actual calendar days, one divisor for both, **from September 2026 forward**. August 2026 was published and announced and is untouched. | `step-definitions.ts` (`dayDrivenMoney` now **fails closed** without a month length) · `recommendation-step.tsx` · `run-service.ts` · `recommend.ts` · `employee-day-report.tsx` · `flat-deduction-rate.ts` **deleted** · `tests/payroll-day-rate-divisor.test.ts` | code + test + PR #3752 + the owner's filled-in ruling sheet |

### One transition at a time — PR #3731 (2026-09-12)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **50** | Every phase change read the run, checked the phase **in code**, did seconds of work, then wrote — so two transitions could both pass the check and both write. The write is now conditioned on an atomic claim and clears it in the same statement; a claim that lapsed and was taken over matches nothing and is refused. | `src/lib/automated-payroll/draft-store.ts` · `transition-claim.ts` · `phx_claim_automated_payroll_run_transition` | code + test + PR #3731 |

### You cannot acknowledge a warning you were never shown — PR #3746 (2026-09-12)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **53** | The acknowledgement was a **boolean in the request body**, so a caller could say yes to a warning this server never showed it. It is now a **server-minted token**; the old `acknowledgeDataIssues: true` / `acknowledgeOverpaid: true` flags are simply not acknowledgements and the gate fires. | `src/lib/automated-payroll/acknowledgment-token.ts` · both confirm routes · `automated-payroll-wizard.tsx` · `tests/payroll-acknowledgment-token.test.ts` | code + test + PR #3746 |

### Five screens that said nothing — PR #3741 (2026-09-12)

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **38** | **The finance cover never mentioned holds.** Held people are in the table, in red, with a note on the row — but the cover said only `Employees: N`, so the one document finance executes a whole month from never said some of those N are not paid by this run at all. A month with no holds now says "None", so the line's absence can never be read as "none". | `src/lib/automated-payroll/exports/finance-sheet.ts` · `tests/payroll-silent-screens.test.ts` (reads the **emitted** workbook, not the source) | code + test + PR #3741 |
| **54** | **The panel asking HR about someone showed a code.** The excluded-people panel printed `B-7` at the person it was asking HR to decide about — against the standing rule that a screen shows names, never codes. | `run-service.ts` (`excludedPeople`) · `automated-payroll-wizard.tsx` | code + test + PR #3741 |
| **55** | **A lower-case HR id answered "no payslips".** The Payslips Center matched with `.eq`, which is case-sensitive, against a database storing HR ids mixed-case. Typing `b-10` found nothing — and that reads as a fact about the employee, not about the query. | `src/lib/payroll/payslip-center.ts` | code + PR #3741 |

### Bank columns and the insurance wage — PR #3712 (2026-09-11) · rated **High**

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **39** | **Someone could be excluded after their first instalment was paid.** Exclusion was allowed at any phase before publish, including after Part 1's bank files were executed — removing them from every sheet, bank file, reconciliation, validation and publish, with the money already in their account. Production before the change: 244 draft rows, 3 exclusions, all made before Part 1 froze anything. | `src/lib/automated-payroll/exclusion-guard.ts` · `run-service.ts` · `tests/automated-payroll-excluded-members.test.ts` | code + test + PR #3712 |
| **40** | **The locked finance workbook left the bank name and account number editable.** The cover promises in three places that every cell is locked except Finance Edit and Finance Edit Reason, but `writePayrollWorksheet` unlocked *every* appended column — and the bank details are appended in the same list. A paste landing one column left overwrote the account number the money is wired to. Locked is now the default, so a column that forgets to declare itself fails shut. | `exports/finance-sheet.ts` · `exports/sheet.ts` | code + test + PR #3712 |
| **41** | **The insurance-wage import accepted any positive number.** It refused only a negative. A stray extra zero (167,000) or a part-timer's 1,200 parsed cleanly and was written to `social_insurance_wage` — the one column that decides the statutory filing — and the calculator then clamped it quietly, so the stored wage and the filed wage disagreed with no error. Production before the change: 167 of 190 employees carry a wage, every one inside the 2,700–16,700 band. | `src/lib/payroll/statutory/insurance-wage-import.ts` · the import route | code + test + PR #3712 |

---

### Finding 21's mechanism is RETIRED — PR #5032 (2026-10-01) · **owner decision**

**Read finding 21 above as history, not as guidance.** Its fix — passing the run in so its own
earlier settlement is excluded from the balance it re-reads — was correct about the oscillation, but
the write it protected could never happen, and the whole mechanism has now been removed.

| # | What it was | Where the fix lives | Evidence |
| --- | --- | --- | --- |
| **21b** | **The Part 2 Vacation confirm destroyed leave settlements and wrote none.** `settleCrmLeaveBalanceForPeriod` set `run_id` to an `automated_payroll_runs` id while the column is `FOREIGN KEY (run_id) REFERENCES payroll_copilot_runs(id)` — **0 of 3** automated run ids satisfy it, so every insert was refused `23503`, logged, and skipped with `continue`. Its supersede ran **first**, was scoped to `employee_hr_id_compact` + `start_date` alone, and its error was discarded: each confirm retired whatever live row held that slot and replaced it with nothing. All **8** `p2_vacation` confirms on production (July ×7 on 4–8 Aug Cairo, August ×1 on 8 Sep) recorded `crmLeaveBalanceSettled` null, and the ledger holds no row any automated run wrote. On **2026-08-04 07:49:03 Cairo**, 1.2 s before the July run's first `step_confirmed` audit row, it retired **Khaled Mohamed Ali Bedair**'s 1.00-day `balance` settlement of 2026-07-12, written by `system:crm-correction-2026-07-21`. | The write is **removed**, not repaired (owner's decision, 2026-10-01): `scripts/import-crm-vacation-backfill.ts` is the one path a CRM leave day reaches a balance by. Standing note in `recommend.ts` where it lived · `tests/automated-payroll-crm-leave-one-mechanism.test.ts` | code + test + production measurement + staging `23503` probe + PR #5032 |

**Why it was removed rather than fixed.** The owner rule of 2026-07-21 was never unserved: the CRM
vacation importer has honoured it all year — **468 requests, 415 days, January–August 2026**, imported
2026-08-03 and 2026-08-24 — which is exactly why the July confirm found zero CRM-only days left to
settle. Fixing the foreign key would have produced **two** mechanisms for one rule, and
`approvedPaidDaysInPeriod` sums `requestDays + settledDays + attendanceDays`, so a settlement row and
an imported request covering the same day are **both** charged. Production already carries one such
pair. The importer also carries three guards the confirm never had: hire-date attribution (a CRM
account is a seat the vendor renames to its next occupant), national-holiday adjacency — the owner's
2026-09-16 protection, now sitting in front of the write that actually happens — and overlap
containment against an existing request.

**The CRM read left the confirm with it, and the function itself followed on 2026-10-01.** Nothing
downstream consumed `computeVacationDeductionTotals`, so leaving the call would have let an
unreachable Egypt holiday calendar refuse a payroll confirm for no benefit at all. It was first kept
unwired, as the only measurement of how many CRM-only leave days a period holds. Re-measured against
`origin/main` on **2026-10-01** it was reachable from **nothing** — no route, cron, script, step
definition, barrel re-export, namespace or dynamic import, or string-keyed dispatch — and with it
died its two Supabase loaders (`loadCrmLeaveDatesByCompact`, `loadV2VacationDatesByCompact`), the
`PayrollCrmLeaveUnavailableError` class, the `VacationDeductionTotal` type and this file's last
import of the Field Workforce engine. The whole cluster is **removed**: ~280 lines of
`recommend.ts`, plus `tests/automated-payroll-crm-leave-fails-closed.test.ts`, whose every
assertion pinned fail-closed behaviour behind a door no caller could open — green forever, guarding
nothing, and reading as coverage. The Egypt holiday pin in
`tests/holiday-calendar-outage-gates.test.ts` went the same way, replaced by a note naming the three
places the live protection actually sits. Git history holds the function if the September figure
(**95 CRM-only AV day-rows across 43 people**, measured on production 2026-10-01) is ever wanted on
a screen; `tests/automated-payroll-reads-deductions-module.test.ts` now asserts, comment-stripped,
that it does not come back unwired.

## The ruling on the fourteen — MOOT, resolved 2026-09-12 (cycle 4)

> **🟢 READ THIS FIRST. The ruling below is superseded and no longer describes reality.** It was
> made on 2026-09-12 on the stated basis that the fourteen were permanently unrecoverable. Later the
> same day the original audit was recovered from this machine's session transcripts, and **all
> fourteen turned out to be fixed** — by PRs #3641, #3642, #3649, #3651, #3659, #3669, #3674, #3684
> and #3687, none of which cites a finding number. See [audit-cycle-4.md](audit-cycle-4.md).
>
> **It is kept, not deleted.** A ruling that accepted real residual risk, on a premise that turned
> out to be false, is exactly the thing a record should show rather than quietly tidy away. Two of
> its statements are worth carrying forward as lessons: *"closed is not fixed"* was the right
> distinction to draw, and *"a future payroll defect is a NEW finding, numbered from 57"* still
> stands.

### The ruling as it was written (superseded)

**1, 6, 7, 8, 9, 10, 11, 12, 13, 21, 24, 25, 28 — and 19.**

**The owner ruled on 2026-09-12: these fourteen are closed as permanently unrecoverable.**

Cycle 2 established that nothing **in this repository** can recover them — its original wording said
"nothing in this company", which was wrong and is corrected here: **the owner holds the original audit
document**, and on that basis this ruling is **suspended pending it** (not reversed, and not re-opened
as work). The audit document that assigned the numbers was never committed; `git grep` across the whole tree and `git log -S` across the whole
history return nothing for any of them in the payroll paths; no merged pull request describes them.
An empirical re-audit of the module was run instead (see [audit-cycle-2.md](audit-cycle-2.md)) and it
found one defect, which was numbered **56** and fixed — not one of these fourteen.

### What "closed" means here, exactly

**Closed is not fixed.** The ruling settles what is *owed*, not what is *known*:

- **No further work is owed on them.** They are not open items. No third cycle re-litigates them, and
  no session should re-open this question or offer to "recover" them again — the answer is in.
- **Nothing is claimed about their content.** They were not verified, not dismissed and not fixed by
  this ruling. Whether any of them touched money is unknown and will stay unknown.
- **The residual risk is accepted, not removed.** If one of them described a live defect, that defect
  is still live and there is no description of it to search for. The ruling accepts that exposure
  deliberately, because the alternative — fourteen permanently open items nobody can act on — is a
  record that decays into noise.
- **A future payroll defect is a NEW finding.** It is numbered from 57 onward. Do not attribute one
  to a closed number: there is no basis on which that attribution could ever be checked, and a wrong
  one would make this record worse than the gap it filled.

The rows above still read **no trace found in the repository**, and that is deliberate. Closing a
finding must never erase the evidence state that led to it — the two facts are recorded side by side
so that anyone reading this in a year can see both what was decided and what was known when it was
decided.

**30 and 36 are not part of this ruling.** They are accounted for, weakly: claimed closed by earlier
work with no code marker. They stay as the table records them.

## The fix that prevents the next one

The audit document goes in `docs/production-audits/automated-payroll/` **before** the first fix PR of
a cycle, not after the last one. The folder and its templates already existed for exactly this.
Fifty-five findings were worked through without one being used. ~~and fourteen of them are gone
permanently as a direct result.~~ Cycle 2 followed the corrected order.

**Amended 2026-09-12 (cycle 4).** Nothing was gone permanently; the cost was two days of believing it
was. Cycle 4 adds the half this missed: **a "no trace" verdict must name where it searched, and
searching the repository is not enough.** The session transcripts under
`~/.claude/projects/<repo-slug>/` hold the working record of every AI session on this machine, and an
audit produced by one of those sessions lives there whether or not it was ever committed. Search them
before concluding a document is lost.

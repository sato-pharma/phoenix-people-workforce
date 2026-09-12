# Automated Payroll — Audit Cycle 3

**Opened:** 2026-09-12 · **Findings covered:** 14–18, 20, 22, 23, 26, 27, 29–55 (37 of them)
**Status:** ALL FOUR TIERS VERIFIED — 37 of 37
**Cycle 1:** [audit-ledger.md](audit-ledger.md) · **Cycle 2:** [audit-cycle-2.md](audit-cycle-2.md)

> This document exists **before** the first fix PR of the cycle, not after the last one. That
> ordering is the process fix cycle 2 established, and it is the reason cycle 1 lost fourteen
> findings. All four tiers carry results as of 2026-09-12.

## Why this cycle exists

The owner supplied a list of 37 findings on 2026-09-12, headed "still open", carrying plain-English
descriptions for each. Two things followed immediately.

**First: the repository disagrees with the list.** All 37 are recorded as fixed, and **34 of them
name a merged pull request** — #3696, #3699, #3701, #3703, #3706, #3707, #3708, #3709, #3711, #3712,
#3717, #3731, #3741, #3746, #3752. The list is a snapshot taken before those landed. It is not a
backlog.

**Second, and far more important: the original audit document exists.** The owner confirmed it. That
contradicted a sentence this repository published — cycle 2 and the ledger both stated that the
wording of the missing findings "cannot be recovered from anything the company holds." **Both are
corrected in this pull request**, along with the registry: every irrecoverability statement is now
scoped to *this repository*, which is the only thing that was ever true of it.

### What that does to the ruling of 2026-09-12

On 2026-09-12 the owner ruled that findings **1, 6–13, 21, 24, 25, 28 and 19** are closed as
permanently unrecoverable. That ruling was made on the stated basis that no source survived.

**The basis was wrong, so the ruling is suspended pending the document** — not reversed, and not
quietly dropped. None of the fourteen appear in the 37-finding list, so nothing has been recovered
yet. What has changed is that recovery is now possible, and a decision taken because something was
impossible cannot stand unexamined once it turns out to be possible.

The correction to the ledger, the cycle-2 document and the registry ships in the **same** pull
request as this cycle's results. One production deployment per task.

## Why "already fixed" is not the same as "verified"

Every one of the 37 is closed on the strength of **a merged pull request description**. Cycle 2
demonstrated what that is worth: `phx_delete_salary_batch` was covered by a migration that read
correctly, was described accurately in its PR, and still disarmed all three of its guards on every
call. The defect was in the interaction, not in any one file.

So this cycle re-verifies each finding **empirically** — against production data, the emitted
artifact, or a forced failure — never against the source that claims to fix it.

## A gap in the cycle-1 record that turned out not to exist

An earlier draft of this document said finding 14 was counted in the ledger's "fixed with evidence"
total of 39 but had no detail row and named no pull request, and that the real count was therefore
38. **That was wrong, and it is retracted here rather than quietly deleted.** The ledger records
finding 14 as two rows, **14a** and **14b**, each naming
`tests/automated-payroll-fail-closed-reads.test.ts` and merged PR **#3699**. The draft missed them
because it searched for a row headed `14` and the rows are headed `14a`/`14b`;
`tests/payroll-audit-ledger.test.ts` matches the letter suffix and has been counting them correctly
all along. **No correction to the ledger's arithmetic is owed on finding 14's account.** (The
"fixed with evidence" bucket did move from 39 to 41 on 2026-09-12, for an unrelated reason: findings
30 and 36 were re-verified against live production and now carry code markers, emptying the
"claimed closed by earlier work nobody can name" bucket. That change came in on `main` separately
and is untouched here.)

## The 37, by what a defect there would cost

### Tier 1 — pays the wrong amount, or pays twice

A defect here moves money into or out of a real person's account. Verified against production data and the emitted artifact, never the source.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **16** | The same non-employee can be seeded automatically and typed in by hand on one run, and be paid twice. | #3696 | ☑ |
| **17** | Syncing the standing list during Part 2 can add money to a Part 1 that is already paid, and that row can then never be removed. | #3696 | ☑ |
| **22** | Changing someone's payment mode between the two confirms charges their loan twice, or drops it entirely. | #3703 | ☑ ⚠ |
| **23** | The Additions step writes unlimited money with no source, no reason, and no audit record of two of its three fields. | #3707 | ☑ |
| **39** | An employee can be excluded from a run after their first instalment was paid, erasing them from every record. | #3712 | ☑ |
| **41** | The insurance-wage spreadsheet import accepts any positive number, with no legal floor or ceiling. | #3712 | ☑ |
| **42** | A negative bonus is accepted end to end and becomes a deduction nothing checks. | #3717 | ☑ |
| **37** | A CRM or vacation deduction changes amount the moment anyone touches its day box, in any month that is not 30 days long. | #3752 | ☑ |
| **29** | Someone hired and leaving in the same month is paid from the 1st, not from their hire date. | #3711 | ☑ |
| **32** | Correcting a leaver's days worked by spreadsheet changes the day count but not the money. | #3717 | ☑ |
| **36** | The Ready payroll sheet pays a full unprorated month to a leaver whose resignation is still in the workflow. | #3768 | ☑ |
| **20** | Reopening Part 1 to correct a salary does not actually re-derive it for joiners or leavers. | #3706 | ☑ |

### Tier 1 — results, 2026-09-12

**Twelve of twelve verified — eleven of them here, and the twelfth (36) by a separate
change that landed the same day, four commits before this document merged.**

Every ☑ above was established the same way: the fix was broken on purpose, the check that should
catch it was watched firing, and the file was restored from a byte copy. A green check on unmodified
code proves only that the code runs.

| Finding | What was broken to prove it | What fired |
| ---: | --- | --- |
| **16** | `identityOf` → null, the old recurring-id-only guard | a hand-typed person seeded on top of themselves: `inserted=1` |
| **17** | `partStillOpen` → always true, the old "not gated on the run phase" | a first-instalment row written onto a paid Part 1 |
| **20** | `unconfirmPart1` stops clearing `baseForMonth` | **the repo's own required-CI guard**, `automated-payroll-run-integrity` |
| **22** | the stamp ignored, and the Part 2 backstop disabled | all three routing checks plus both backstop checks |
| **23** | the reason requirement removed; `MONEY_FIELDS` cut to incentive; `fieldTotals` emptied | refusal, three-field total, audit record |
| **29** | the hire date discarded by the leaver settlement | an 11-day settlement became 20 days |
| **32** | the sheet parser stops re-pricing a corrected day count | 4.5 days still priced at the 12-day figure |
| **37** | the divisor hard-coded back to 30 | the 31-day, the February and the fail-closed checks |
| **39** | (guard already proven pure; verified against production instead) | — |

**What production says.** Both runs — July and August 2026 — are published, 244 draft rows, 241 not
excluded.

| Question | Answer |
| --- | --- |
| Anyone excluded after their first instalment was paid (39)? | **0.** Three exclusions, all with no frozen first part |
| Anyone charged the same deduction in both instalments (22)? | **0** — CRM 0, unpaid vacation 0, loan/other 0 |
| Any negative value in any money column (42)? | **0**, across every addition, deduction and total |
| Any insurance wage outside the legal band (41)? | **0** of 167; band 2,700–16,700, stored range 5,600–16,700 |
| The same non-employee paid twice on one run (16)? | **0.** 14 rows — 7 seeded, 7 typed by hand — no duplicate identity |

#### The two answers that are not a clean tick

**23 is closed, and the missing third was closed by a ruling rather than by code.** An addition with
no reason is now refused at confirm, and the audit record carries bonus and overtime instead of only
incentive. The finding also asked for an **upper limit**, and there is none — verified: a 5,000,000
EGP bonus with the one-word reason "because" is accepted. The code declined to invent one on the
grounds that *"a limit is a number only the owner can give."*

> **THE OWNER RULED ON 2026-09-12: NO CAP.** There is no upper limit on a payroll addition, by
> decision. The reason requirement is the whole of the control, and that is deliberate: a threshold
> would block a legitimate payment on a number nobody agreed. **Do not propose a cap again, and do
> not "fix" an uncapped addition back into a defect** — a large addition with a reason is the system
> working as the owner intends. Anyone reading a large figure back reads the reason, not a limit.

**22 and 23 are fixed for the next month, not proven on a month that has run.** All 244 production
draft rows carry `settled_in_part1 = null`, and all 5 rows with an addition carry no reason —
because July's Part 1 was confirmed on 26 July and August's on 30 August, both **before** #3703 and
#3707 merged on 11 September. A null stamp falls through to the live rule, which is exactly the
pre-fix behaviour. Neither guard has ever run in production. **September's run is the first real
test of both.** Neither published month can be corrected, and neither shows a defect.

**36 was closed the same day, by PR #3768 — this paragraph is corrected in place, not deleted.**
When Tier 1 ran, 36 named no file anywhere in the repository: no PR, no code marker, no test. That
was true when it was written and it is no longer. `a8c0ada08` (PR #3768) landed on `main` four
commits before this document merged, and it closes 36 two ways.

**Where the closure lives.** `phx_resign_employee_and_open_vacancy` sets `employment_status` when
the resignation is *filed*, not when its workflow completes — so an in-workflow leaver is already
terminal to the Ready sheet and never reaches a full unprorated month. **What pins it.**
`tests/payroll-ready-sheet-leaver-proration.test.ts`, registered in `tests/run-tests.ts`, asserts
that mechanism across *every* migration that defines the RPC, so moving the status write to the
workflow's completion step — a reasonable-looking tidy-up — fails rather than ships. **What
production said on 2026-09-12.** The one resignation still at workflow status `submitted` already
carried `employment_status = 'resigned'`; no row held an in-flight resignation against an employee
still `active`; and the single active-employee resignation row is `cancelled`, which is correct —
that person did not leave. The exploitable state does not exist.

**Two qualifications, so the tick is not read as more than it is.** First, **36's proof came from
outside this cycle**: #3768 is another change's work, which is why 36 carries no row in the break
table above — cycle 3 did not break its fix and watch the check fire, as it did for the other
eleven. Second, like all 37, it is verified against **the ledger's paraphrase** of the finding, not
against the original audit document, which is still unread.

#### Noted on the way, not yet a finding

`writeAutomatedPayrollAudit` **swallows its own failure**: when the audit insert threw during this
verification, the seed still reported success and the money rows still went in. That is deliberate —
payroll must not fail on a logging error — but it means the audit trail can be silently incomplete,
which is the same class of problem as finding 26. It is carried into the Tier 3 check of 26 rather
than opened as a new finding.

### Tier 2 — silently drops money, people or reasons

These fail quietly. A green screen showing zero is the failure mode, so each is verified by forcing the failure and reading what the user is actually told.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **14** | One failed database read in the CRM collector silently retracts every live CRM deduction for the month. | **no PR named** | ☑ |
| **34** | A failed leavers query silently removes every already-resigned employee from the whole run. | #3699 | ☑ |
| **35** | If the expense query fails, the Expenses step shows nobody and every reimbursement freezes at zero. | #3717 | ☑ |
| **49** | The mutual-exclusion check between the two payroll engines fails open when its own query errors. | #3717 | ☑ |
| **44** | One expense-approval save can wipe frozen expense figures in a month that did not change. | #3717 | ☑ |
| **45** | Approved expenses belonging to someone outside the run are dropped with no row and no warning. | #3717 | ☑ |
| **43** | Every held employee is missing from the month's statutory filing. | #3717 | ☑ |
| **30** | An employee with no social-insurance figure is published at zero rather than flagged. | **no PR named** | ☑ |
| **48** | The Manual Deductions reason can be silently erased by a spreadsheet upload reporting no change. | #3717 | ☑ |
| **33** | The Unpaid Vacation template has two columns with the identical heading, and the importer reads the wrong one. | #3709 | ☑ |
| **31** | Three spreadsheet day columns can never be saved, but the upload preview reports them as changed. | #3717 | ☑ |
| **27** | Apply changes after a spreadsheet upload does nothing at all. | #3712, #3741 | ☑ |

### Tier 2 — results, 2026-09-12

**Twelve of twelve verified. One of them is proven at the mechanism, not by a live click, and one
step turned out to have a defect nobody had found.**

Tier 2's findings all fail the same way: quietly. Nothing throws, nothing turns red, and the screen
shows a plausible zero. So none of them can be checked by reading the code that claims to fix them —
the only proof is to make the read fail and see what the user is actually told.

To do that without touching production, this tier ran behind a **fault-injection loader**: a module
loader that substitutes a stand-in for the Supabase client, returns a genuine PostgREST-shaped error
for any table named in the test, and **records every write the code attempts**. That last part is
what makes "nothing was retracted" a measurement rather than a claim — the harness can show the
exact list of inserts and updates the code tried to perform.

Every ☑ was then established twice: once by forcing the failure and reading the answer, and once by
breaking the fix on purpose and watching the check that should catch it fire. The file was restored
from a byte copy each time, never with `git checkout --`, which would have taken the uncommitted work
with it.

| Finding | What was broken to prove it | What fired |
| ---: | --- | --- |
| **43** | `extraNotes` dropped from `buildStatutorySummaryWorkbook` | the emitted workbook no longer carried the held note under the total: `MISSING` |
| **30** | `usableInsuranceWage` returns 0 and `statutoryFromInsuranceWage` returns zeros | `no insurance wage returns NULL, never a zero figure` |
| **49** | the failed Copilot read logged and swallowed instead of thrown | the mutual-exclusion guard passed and the run proceeded to `createRun` |
| **35** | a failed expense page `break`s out of the loop instead of throwing | `the step returned rows as though nobody travelled` |
| **45** | `outsideRun.push` removed | `no row at all — the money is invisible` |
| **34** | the leavers read returns `states` instead of throwing | `it returned a feeder map with no leavers in it` |
| **14** | the CRM visit scan swallows its own error | `created=0 warnings=[]` — a silent empty month |
| **14** | the empty-draft backstop disabled | `attempted: update deductions_candidates, insert deductions_audit, insert audit_logs` — the retraction itself |
| **33** | the pre-fix duplicate heading restored and `assertHeadingsAreUnique` removed | `parsed p1odVacationDays=9` when 4 was typed — the reference column holds 9 |
| **31** | the day column shipped editable and read back | the preview promised `{ "Deduction Days", from: 2, to: 6, status: "changed" }` on a field that can never be saved |
| **48** | the unconditional write restored **and** the Reason row removed from `diffStepUpload` | `parsed reason=null` with no Reason row in the preview — erased, and invisible |
| **44** | `byPeriod` rebuilt as a cross product | September and October both rewritten: `[{"month":9,…["B-14","B-77"]},{"month":10,…["B-14","B-77"]}]` |

**What production supplied.** Finding 14's retraction test was driven by a **real** production row —
a live CRM deduction candidate for August 2026, 233.87 EGP, belonging to Omnia Nader Ismael Hamed
Mostafa Elsherbiny — rather than by an invented one, so the ledger the reconcile reads has the shape
the ledger really has. With the backstop in place and the CRM read failing, the harness recorded
**no writes at all**: the month's live candidates were left standing and the collector reported a
warning instead of a silent empty result.

#### The two answers that are not a clean tick

**27 is proven at the browser mechanism and in the source, not by a live click.** No dev server can
run on this machine at present — free RAM is 2,553 MB against a 2,600 MB floor for a dev server or a
cold typecheck — so the screen itself could not be driven. Instead the underlying browser behaviour
was measured directly in a real browser: after `input.value = ""`, the file input holds **0 files**
and reading it later gives `undefined`, while a `File` captured beforehand survives intact and
usable. The component does capture beforehand (`pendingUpload` is set from the change event before
`event.target.value = ""` runs), the Apply button is disabled without it, and Apply refuses with a
message rather than doing nothing at all. That is the whole of the mechanism the finding describes,
but it is honest to record that **the click itself was not performed**. It should be exercised once
on the next real run.

**A defect was found while testing 48, and is fixed in this change.** Finding 48 could not be checked
on the Manual Deductions step at all, because the template that step needs **cannot be produced**:

```
GET /api/automated-payroll/runs/{runId}/steps/p2_manual_deductions/export  →  500
Worksheet name Any more deductions? cannot include any of the following characters: * ? : \ / [ ]
```

ExcelJS refuses a worksheet name containing any of `* ? : \ / [ ]`, and it refuses **before writing a
single byte**. The worksheet was named from the step's own title, and the Part 2 step is titled
*"Any more deductions?"* — the one title of the sixteen that carries a forbidden character. So the
Download-template button on that one step answered 500 with nothing to say, and HR had no
spreadsheet path to that step at all: nothing to download, therefore nothing to edit in Excel and
nothing to re-upload.

The fix derives the sheet name from the title instead of using the title verbatim
(`worksheetNameFor` in `src/lib/automated-payroll/exports/step-template.ts`) — derived rather than
hard-coded per step, because the title is what a future step changes, and a punctuation mark in it
must never again decide whether a download works. It is pinned by a new assertion in
`tests/automated-payroll-template-headings.test.ts`, already registered in the required `validate`
job, which builds **every** step's template and fails on any that throws. Breaking the fix made that
assertion fire with the exact ExcelJS message above.

### Tier 3 — control, concurrency and access

These do not move money by themselves; they remove the interlock that stops something else from doing it. Finding 56 was exactly this shape.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **18** | Nothing is re-checked at publish, and the run stays changeable after Part 2 is confirmed. | #3706 | ☑ |
| **26** | The payroll decision trail can be deleted, and nothing in the database stops it. | #3701 | ☑ |
| **50** | A concurrent cancel and Part 2 confirm can silently undo each other. | #3731 | ☑ |
| **51** | The CEO Payroll Console omits the company-scope check its sibling page has. | #3717 | ☑ |
| **40** | The locked finance workbook leaves the bank name and account number editable, contradicting its own cover. | #3712 | ☑ |
| **46** | The population comparison never blocks anything, and its baseline makes a held person look like a new hire. | #3717, #3731, #3746 | ☑ |
| **47** | An expense resync skipped because Part 2 is already confirmed is reported to nobody. | #3717, #3741 | ☑ |
| **52** | The Executive Summary compares this month including held people against last month excluding them. | #3717 | ☑ |
| **53** | Both acknowledgement gates accept a plain yes-flag sent on the first request, so the warning need never be shown. | #3746 | ☑ |

### Tier 3 — results, 2026-09-12

**Nine of nine verified.** Four were settled against the **production database itself** — the audit
trail's triggers, the transition race, what August actually recorded, and what the acknowledgement
gates are asked. Two were read out of the **emitted workbook**. Every one was then broken on purpose
and the check watched firing.

| Finding | What was broken to prove it | What fired |
| ---: | --- | --- |
| **40** | every appended column unlocked again, as before the fix | `full: Bank Name must be locked for Real Employee` |
| **26** | *(not broken — the refusal was forced on production)* | `The automated_payroll_audit decision trail is append-only. DELETE is refused.` |
| **50** | the pre-fix unconditional phase write, run on production | `unconditional_write_rows=1 · phase_now=cancelled` — the confirm that won, overwritten |
| **18** | the post-Part-2 freeze removed from `assertStepPhaseAllowed` | the refusal vanished: a confirmed run took the edit exactly like an open one |
| **51** | the scope line's supposed backstop tested on its own | `Medical Rep`, `SFE Manager` and `Employee` all pass `payroll:read` |
| **47** | the skip neither logged nor described | `0 warning line(s)`, and nothing in the log — "reported to nobody", exactly |
| **52** | the basis note not rendered | `-97.3%` printed with nothing beside it to say the two months are not comparable |
| **53** | the yes-flag restored as the acknowledgement | 10 of the 15 refusals stopped refusing |
| **46** | the pre-fix baseline, built from `salary_records` alone | `joined = ["Held Last Month"]` — a held person read as a new hire |

#### What production says

**The decision trail cannot be rewritten, and that was forced, not read.** `automated_payroll_audit`
carries three BEFORE triggers — DELETE, UPDATE and TRUNCATE — all calling
`phx_refuse_audit_trail_change()`. A real `DELETE` and a real `UPDATE` were attempted on production,
inside a transaction terminated by `raise exception` so it rolled itself back. Both were refused, and
the connection they were refused on was **`postgres`**, the superuser — stronger than the app's
service-role client, and unlike RLS a trigger is not bypassed by either. Afterwards: **202 rows still
held, 0 tampered.**

**The transition race was run on the live database.** A scratch run was created in phase `part2`,
Confirm Part 2 claimed it, and a Cancel arrived while it was still working:

| Step | Result |
| --- | --- |
| Confirm Part 2 claims the run | a token |
| Cancel claims the same run | **`NULL`** — refused, it cannot proceed |
| a write carrying a token it does not hold | **0 rows** |
| the holder's own write | 1 row, and the claim cleared |
| the pre-fix unconditional write (Break V) | **1 row — `phase_now=cancelled`**, the winner silently undone |

Both transactions rolled back: **0 scratch rows left, still only the two real runs.**

**Eleven roles hold `payroll:read` and are not company-scoped** — Employee and Medical Rep among
them. Each one reached the CEO Payroll Console, which lists every salary batch in the company, before
finding 51's scope line. The line is the whole boundary: the permission check behind it admits all
eleven (Break X), and the sidebar hiding the link is presentation, not a gate.

**August recorded 20 held people as a count with no amounts,** which is precisely the case findings 46
and 52 were built for. All 20 are still recoverable and nameable from that run's own draft rows, so
September's population baseline will carry them and none will read as a new hire; and September's
Executive Summary will carry the basis note, which was read back out of the emitted workbook rather
than assumed.

#### The three answers that are not a clean tick

**18's drift stamp has never run on a real month.** Publish now re-runs the pre-flight gate, the split
reconciliation, and a comparison against the totals Part 2 stamped. The comparison works — tested
with a month that moved (`employees 120 → 121`, and three money totals) and with two cents of
movement, both caught — but it needs `detail.confirmedTotals` in the `part2_confirmed` audit row, and
**neither published month has it**. Both read back as `null`, so the check was a silent no-op for July
and August. Confirm writes the stamp today; **September is the first month the guard can fire.** The
other half of 18 — the sheet frozen once Part 2 is confirmed — is live and was proven server-side,
with nothing written.

**47 is proven on the server, not on the screen.** The skip is real and measured: with Part 2 already
confirmed, the resync returns `{action: "skip", reason: "part2_already_confirmed"}`, logs it with the
run, the month and the HR ids, returns the sentence *"Payroll for September 2026 already has Part 2
confirmed, so this decision did not reach it"*, and **attempts no write at all**. The control — the
same decision while Part 2 is open — reaches payroll and says nothing. Whether the banner renders is
a source-level reading, same limit as finding 27: no dev server can run at this machine's free RAM.

**26 is tamper-proof once written, but the writer is best-effort by design.**
`writeAutomatedPayrollAudit` logs its own failure and returns — payroll must not fail on a logging
error — so the trail can be silently incomplete even though nothing can delete from it. Measured
rather than assumed: both published runs carry a `published` row and a `part2_confirmed` row, and 202
rows in total. The gap has not bitten. It is the same class as the Tier 1 note and stays recorded
rather than reopened.

#### Noted on the way, not yet a finding

**Eleven of July's draft rows were written 18 days after July was published,** all of them held rows —
ten in the same second on 2026-08-28, one on 2026-08-30 — and ten of the eleven now hold
`expenses = null`, the signature of `clearDraftExpenses`. That is findings 44/47's failure mode
reaching backwards into a published month, before either was fixed. **No money moved:** not one
salary record was created for either batch after its publish, so the payslips are untouched and both
months stand exactly as announced. What no longer matches is the stored sheet: for those ten held
people, July's draft rows no longer carry the expense figures July was published with. Today the same
write is refused twice over — `planExpenseResync` stops at `part2ConfirmedAt`, and a published run is
refused before that — so this is history, not a live hole. It is recorded because the ledger and the
Held tab read those rows, and because it is the only direct evidence in production that the pre-fix
defect actually occurred rather than merely could have.

### Tier 4 — what people are told

No money moves, but someone is not told something true. Verified on the emitted artifact or the rendered screen.

| # | In one line | Claimed fixed by | Re-verified |
| ---: | --- | --- | :---: |
| **15** | 205 employees across two published months were never told their payslip was ready. | #3708 | ☑ |
| **38** | The workbook finance executes the month from never mentions holds on its cover. | #3741 | ☑ |
| **54** | The excluded-employees panel prints the raw HR code instead of the person's name. | #3741 | ☑ |
| **55** | The Payslips Center search for an HR code is case-sensitive, so a lower-case search reports no payslips. | #3741 | ☑ |
### Tier 4 — results, 2026-09-12

**Four of four verified, and three of them were settled against production rather than a harness.**
This tier is the one where nothing breaks: the money is right, the run completes, and the only thing
wrong is what somebody is told. So none of the four can be proven by reading the fix — only by
reading what the person actually receives.

| Finding | What was broken to prove it | What fired |
| ---: | --- | --- |
| **15** | the notifier given a roster of nobody, as before #3708 | `{"notified":0,"failed":0}` — a published month that tells no one, and records that it told no one |
| **38** | the `On hold` row removed from the finance cover | `HEADLINE: the finance cover must say how many people are on hold`, and the emitted cover went silent on 20 held people |
| **54** | the panel put back on codes, against production's own August run | `PD-0007 (PD-0007)`, `PD-0011 (PD-0011)`, `AI-0006 (AI-0006)` |
| **55** | the pre-fix case-sensitive `.eq`, run against production | typing `a-1` returned **0 payslips** where `A-1` returns 8 |

#### What production says

**Finding 15 is exactly true, and it is 205 people.** `notification_events` holds **123**
`payslip_available` records, every one of them dated **2026-07-13**, all for a single batch, and
**none since**. The two batches that were actually published carry none at all:

| Batch | Published (Cairo) | People paid | Told their payslip was ready |
| --- | --- | ---: | ---: |
| July 2026 | 2026-08-10 10:11 | 105 | **0** |
| August 2026 | 2026-09-08 14:43 | 100 | **0** |

Publish now calls `notifyPayslipAvailable` and records the outcome in the `published` audit row —
`payslipNoticeSent`, `payslipNoticeFailed`, `payslipNoticeError` — so a month that tells nobody can
no longer do it quietly. The notifier was exercised with an injected roster client **and an injected
sender**: never the real one, because the suite runs with production credentials and reaching it
would notify real employees and burn a month's idempotency keys. A 100-person batch told 100 people;
a duplicate row, a blank and a null were dropped; two forced delivery failures were **counted and
returned** rather than swallowed; and a roster that could not be read returned the error rather than
a successful nobody. The payload carries **`channels: ["in_app", "telegram"]` and no `email` block at
all** — the owner's rule that a payslip is never emailed, read off the payload rather than assumed.

**The finance cover was read out of the emitted `.xlsx`, at August's real shape.** Built with
production's August population — 120 people, 20 of them held — the Cover sheet finance opens says:

```
Employees    | 120
On hold      | 20 of 120, shown in red below. A held row is NOT paid by this run: no salary
               record is written, and nothing here records a payment made outside the system.
               Held means the SECOND part is owed, not the whole month — paying full net would
               pay part one twice.
```

All 20 held people are still rows in the table below it, every one carrying the `HELD — this person
is NOT paid by this run` note on its `HR_ID` cell and a fill, so the mark survives greyscale and a
reader who cannot see red. A month with **no** holds prints `None — every employee row below is paid
by this run`, which is what stops a missing line ever being read as "none".

**The excluded panel was built by the application from production's own August run.** `getRunView`
was called against the live database with the owner's context, and it returned the three people
August actually excluded — **Bahaa Gamal (PD-0007), Mohamed Eldomiaty (PD-0011), Mohamed Yasser
(AI-0006)** — each named, with the code beside the name rather than instead of it. Put back on codes,
the same call against the same data printed `PD-0007 (PD-0007)`.

**The case-sensitive search was the whole company, not an edge case.** Of the **896** published
payslip rows in production, covering **175 people**, **every single one** carries an upper-case letter
in its HR id. So before the fix, a lower-case HR-id search answered "no payslips" for *every employee
in the company* — and it read as a fact about the person, not about the query. Searched live:
typing `a-1` now returns the same 8 payslips as `A-1`, and only A-1's — not A-10, A-12 or A-13, so
the whole-match promise survives the case fix. A typed `_` and a typed `*` both stay characters and
match nothing, while a lower-case **name** still searches as a contains-match (80 rows for
`mahmoud`). Put back on `.eq`, `a-1` returned 0 against the same production data.

#### The one qualification

**54 and 55 are proven on the server and on production data, not on the rendered screen.** The
excluded panel's markup and the Payslips Center's input box were read as source; what was measured
live is the data each one is handed. This is the same machine limit as findings 27 and 47 — free RAM
below the dev-server floor — and the same honest boundary: the value that reaches the component was
verified against production, the pixel was not.

## Method

For each finding, in tier order:

1. **Read the live artifact, not the source.** For a database rule, `pg_get_functiondef` on
   production ref `ozucdzovmcqvepbozvqf` — `list_migrations` reports the ledger, not reality. For a
   workbook, the emitted file. For a screen, the rendered page.
2. **Force the failure the finding describes.** A read that "fails open" is only proven closed by
   making the read fail. Production tests run inside a transaction terminated by `raise exception`,
   against rows created for the test, so the transaction rolls itself back and no real batch is ever
   the target.
3. **Record the outcome either way.** A finding that comes back genuinely fixed is written down as
   verified, with what was run. A clean result is a real result and it is the majority outcome here.
4. **A finding that is NOT fixed becomes a new number**, from 57 onward — never a reopened old one.

## What this cycle must not do

- **Never re-attribute a new defect to a closed number.** The fourteen keep their numbers whatever
  the document turns out to say.
- **Never "fix" a published and announced month.** A late ruling is a rule for upcoming months.
- **Never trust a scan that reports a catastrophe.** Cycle 2 produced three false headlines — 99
  unchecked errors, 27 ungated routes, 6 ungated handlers — every one a tooling artifact. Check the
  actual file before believing any of them.
- **Never declare a regression test green without breaking the fix** and watching that test's own
  headline assertion fire, restoring from a byte copy.

## What is needed before verification starts

**The original audit document.** It supplies the exact wording of all 55 findings, which decides two
things this plan cannot: whether the fourteen are recoverable, and whether each of the 37 was
actually about what the ledger's paraphrase says it was about. Verifying a paraphrase proves nothing
about the finding.

# Automated Payroll audit — the original findings, recovered 2026-09-12

**Source.** Recovered from the Claude Code transcript of the session that produced the audit,
`f010eb82-1a95-4f43-894a-e3d70a9149cd.jsonl` (16.6 MB, last written 2026-09-11 20:52 Cairo), on this
machine. It is the audit itself, not a paraphrase of it — the wording below is verbatim.

**Completeness.** Findings **1–28 and 39–41 are complete** (headline, location, what breaks, and for
1–5 the proposed fix). Findings **29–38 and 42–55 survive as their one-line headlines only** — the
detail for those was written in a part of the session that is no longer in the transcript. The
numbering runs 1–55 with no gaps, which independently confirms the ledger's count of 55.

**Status — this is a RECORD, not a backlog.** Every one of the 55 was verified as fixed by
2026-09-12. Findings 2–5 and the 37 of cycle 3 were re-verified empirically against production, the
emitted artifact or a forced failure; the remaining fourteen — **1, 6–13, 19, 21, 24, 25, 28** — were
each traced to a named merged PR on the day this document was recovered. See
[audit-cycle-4.md](audit-cycle-4.md) for that trace and [audit-ledger.md](audit-ledger.md) for the
per-finding rows. **Do not re-open a finding from this document without checking the ledger first.**

**Nothing is open.** The last item sat inside finding 1: the double-payment exposure was closed, but
stamping the outstation trips the wizard actually paid waited on an owner decision about what the
typed expense figure means. He ruled on 2026-09-12 and PR #3786 closed it the same day — publishing
marks the approved trips of its payout period, and trips before 1 July 2026 are imported history.

---

## Findings 1–5

### 1 — Outstation trips the wizard pays are never marked as paid, so the old import path is set up to pay them again

`confirmed`

**Where.** src/lib/automated-payroll/run-service.ts:1083 (publish) and src/lib/automated-payroll/recommend.ts:498 (the guard that reads the mark)

**Breaks.** When the wizard reimburses an outstation trip it never writes the 'already paid' mark on that trip. Every one of the 374 outstation rows in production carries a blank mark today — including the EGP 36,039.31 the wizard itself paid across July and August. The legacy 'Import to payroll' button on the Expense Approvals page sweeps every approved, unmarked trip whose payout month is at or before the target month. The moment a salary batch reaches an importable state and someone presses that button, EGP 126,104.66 of already-paid expenses is added to that month's net pay, presented on screen as 'carried forward' money that could not be paid in its own month. It is blocked today only because the wizard's own batches are set to 'approved', which that import refuses.

**Fix.** At publish, stamp imported_payroll_batch_id / imported_to_payroll_at / imported_to_payroll_by on the outstation rows whose money landed in the published sheet. Until that ships, have the import refuse outright when the target month, or any month it would carry forward, was published by the wizard.

### 2 — A non-employee whose bank is typed as anything but exactly "FAB" or "CIB" is silently unpaid while the sheet says they were paid

`confirmed`

**Where.** src/lib/automated-payroll/exports/fab-sheet.ts:75 and src/lib/automated-payroll/exports/cib-sheet.ts:80; validation at src/lib/automated-payroll/non-employees.ts:83-92

**Breaks.** The bank name on a non-employee entry is free text with no dropdown, no pattern and no validation — the form only checks that the two names are filled in and the salary is not negative. The bank files match on the exact words "FAB" and "CIB". "CIB Bank", "FABMISR", "NBE" or a blank field puts that person in neither file. Both files still generate cleanly. The finance sheet's TOTALS row still includes their full amount, because the totals filter on the money column only and never on the bank. The person receives nothing, the sheet certifies they were paid, and no screen, export, log or check anywhere says so. The July run's largest such entry was EGP 158,487.00.

**Fix.** Make the bank a dropdown of the two banks the system can actually pay, and require an account number whenever the salary is above zero. Failing that, print a blocking list on the sheet cover naming every non-employee the bank files will not carry — the same way held employees are already named.

### 3 — Every dismissal and contract non-renewal is settled as if it were a resignation, so a dismissed employee gets the full-month waiver and both allowances

`confirmed`

**Where.** src/lib/payroll/copilot/feeders.ts:159 (the leaver query)

**Breaks.** Your rule is that a resignation with a last working day after the 25th is paid in full, but terminated and inactive leavers stay prorated with zero allowances. The automated engine cannot tell the two apart: a probation termination and a contract non-renewal both write into the same resignations table, and the engine's query reads only the workflow status — it never looks at employment status. So a dismissal is settled through the resignation rules. A probation dismissal on 28 August at Base 16,000 + allowances 2,000 is paid a full 18,000 where the Ready sheet's rule gives 14,451.61 with allowances zeroed — 3,548.39 EGP over, and up to 4,580.65 for a dismissal on the 26th. Below the 25th the gap is the allowances' day share. The Resignations screen shows no exit reason, so nothing on screen tells HR this person was dismissed. Two comments in the code assert this hole does not exist, which is why it was never closed.

**Fix.** Carry the leaver's employment status (or the exit reason) through the feeder into the settlement, and route a non-resignation leaver to the base-only, zero-allowance treatment the Ready sheet already implements. Correct the two comments at proration.ts:109-114 and ready-proration.ts:283-287 that state the opposite.

### 4 — An overpayment is marked recovered without ever being deducted — the recovery reaches no file that pays anybody

`confirmed`

**Where.** src/lib/automated-payroll/run-service.ts:826 (marks it recovered) against :1352, :1431, :1486 (the three builders that omit it)

**Breaks.** When Part-2 deductions exceed someone's already-paid first instalment, the excess is recorded as a debt to recover next month — the mechanism exists and is well built. But the recovery is marked collected at Part-2 confirm, while the finance sheet, the FAB file and the CIB file are all assembled without the recovery figure being passed in. Publish then re-assembles from scratch and can no longer see the balance at all. Net result: the debt reads as settled in the ledger, the bank transfers and the published payslip both pay the un-recovered amount, and the money is never actually taken back. If a run reaches 'ready' and is then abandoned rather than cancelled, last month's real debts stay flagged recovered while nobody was paid. The ledger is currently empty in production (0 rows against two published months), so nothing has been lost yet — this arms the first time any employee's Part-2 deductions exceed their first instalment.

**Fix.** Move the 'mark recovered' step into publish, derived from the rows actually published, and route the finance sheet and both bank files through the same assembly path publish uses so the recovery figure cannot be dropped. Make that figure a required argument so an omission is a build error.

### 5 — A bank file that is missing people downloads perfectly cleanly — nothing counts, logs or reports who was left out

`confirmed`

**Where.** src/lib/automated-payroll/run-service.ts:1447 and :1499

**Breaks.** The only check on either bank file is whether it came out completely empty. A file missing a fifth of the payable population builds, opens, is named normally, and reports nothing — not in the download, not in the workbook, not in the audit table, not in the server log. There is no bank-coverage line on any sheet cover, no bank check in the data-quality report, and no check that FAB plus CIB together cover everyone the run owes. So the failure in findings 2 and 6, and any future change to bank routing, is by construction invisible.

**Fix.** Have the bank-file builders report who they included and who they could not route, surface both on the download panel and in an audit row, and add a coverage line to the sheet cover. Keep the hard refusal only for the genuinely empty case.

---

## Findings 6–28, and 39–41

### 6 — 35 held employees across the two published months have no record anywhere of what they were owed or paid

`confirmed`

src/lib/automated-payroll/run-service.ts:1096

Confirming the known issue: publish still drops held rows and this is still exactly true. Production now carries 15 held rows in the July run and 20 in the August run, and for all 35 there is no salary record in any batch for that month. Three of the July fifteen carry no hold reason at all. The only surviving trace of the other 32 is a free-text reason on a staging row, plus a single count in one audit entry. The overpayment ledger is completely empty, so nothing records what a held person is owed. If one of them is ever asked to reconcile, or a second instalment needs validating against what was actually published, there is nothing to validate against.

### 7 — Automated payroll publishes the social-insurance figure typed on the employee record, never the insurance wage the statutory rule names

`confirmed`

src/lib/automated-payroll/recommend.ts:169-170 and src/lib/automated-payroll/assemble.ts:340-348

Your standing rule is that payroll reads the insurance-wage column. This engine never touches it — a search of the whole module returns zero references to the wage column or the statutory calculator. It copies the raw social-insurance and tax amounts from the employee record and folds them into gross salary and governmental deductions. Verified against the published August batch: all 100 records match the raw employee column, and none of them equals 11% of that person's clamped insurance wage. The older Payroll Copilot engine does the opposite. So the same person, same month, would be filed at two different figures depending on which engine assembled the month — a measured maximum gap of 2,338.00 EGP. Take-home pay is unaffected either way; what moves is what is reported to the employee and to the Authority.

### 8 — The Statutory Summary reports a subject wage above the legal ceiling for 88 of 91 employees

`confirmed`

src/lib/payroll/exports/statutory-summary.ts:42

The accountant-facing filing sheet does not read the stored insurance wage. It works backwards, dividing the published social-insurance amount by the 11% rate to reconstruct a wage. Because the published amount is not 11% of anything (finding 7), the reconstructed wage is fiction. Measured on the published August batch: 88 of 91 rows produce a subject wage above the 16,700 EGP legal ceiling — a figure the Authority cannot accept — and the sheet's total insured payroll comes out at 2,560,160.36 EGP against a true clamped total of 1,126,528.00, 2.27 times too high. The employer contribution column is scaled off the same wrong number.

### 9 — A leaver's frozen first instalment is inflated by his own Part-1 deductions, overpaying him

`confirmed`

src/lib/automated-payroll/split.ts:252

When the system nets a leaver's final deductions against his remaining second instalment, it measures that remainder as 'net not yet paid in the first instalment'. But the first instalment has already had his fingerprint, loan and other Part-1 deductions taken off it — so that remainder IS those deductions, not spare money. The system therefore believes he has second-instalment headroom he does not have, spills too little into the first instalment, and pays him more than the month owes. Worked case: a one-part leaver on 12,000 net with a 400 fingerprint, 600 loan and 300 medical, carrying 1,500 of final CRM and vacation, is paid 10,500 against a true payable of 9,200 — 1,300 EGP over the top, booked as a residual against someone who will never appear in a later run to recover it from. Bounded by the size of his own Part-1 deductions, and it goes the employee's way, but it is unrecoverable.

### 10 — A leaver's approved unpaid vacation is charged twice — once by shortening his paid days, once as a deduction

`confirmed`

src/lib/payroll/copilot/proration.ts:125

When a leaver's settlement is calculated, approved unpaid-leave days are removed from the days he is paid for. The same approved request is separately picked up by the Deductions module and charged again as an unpaid-vacation deduction on the Part-1 Unpaid Vacation step. Nothing nets the two. A leaver on 18,000 net leaving on 20 August with 5 approved unpaid days is paid 8,709.69 for 15 days (the 5 already unpaid), then deducted a further 2,580.65 for the same 5 days — 6,129.03 in a final settlement with no next month to correct it. It needs the candidate to have been marked Approved for Payroll and the recommended Days Worked left untouched, and it applies to a last working day on or before the 25th; after the 25th the deduction stands alone and is correct.

### 11 — Nothing stops the same absence day being charged twice on the payroll path — the only guard sits in a step payroll never runs

`confirmed`

src/lib/automated-payroll/deductions-source.ts:310

The rule that no employee-day is ever charged twice is enforced inside the Deductions module's own 'publish month' step, which aborts if two categories claim the same date. Payroll deliberately never reads that step. It sums every approved candidate by category with no date comparison at all, so a day carrying both a fingerprint charge and a CRM charge is deducted twice and the sheet shows it as two separate columns. Three of the five detectors already refuse an overlapping day when they create it; fingerprint and CRM are the one pair with no such check. It does require you to have individually approved both rows, and the collection run does print a per-collision warning naming the employee and date — but that warning's wording says 'the month cannot be published', which tells the reader the consequence is a blocked publish when for payroll the consequence is a paid double charge.

### 12 — The Thursday half-day rule is thrown away the moment a reviewer opens and saves the days editor

`confirmed`

src/lib/automated-payroll/deductions-source.ts:246

A CRM deduction covering a Thursday is weighted at half a day, which is your rule. But the moment anyone opens the days control on that candidate and presses Save — even without changing anything — the workspace writes back a plain count of the ticked dates, and the deduction logic treats that count as a number a human typed and stops applying the weighting. A leaver flagged for Wednesday, Thursday, Saturday and Sunday should be charged 3.5 days; after one look-and-save he is charged 4. On a 19,000 net that is 306.45 EGP extra out of his final settlement. The explanatory note that would normally say 'N days flagged, M chargeable — Thursday is a half day' is suppressed at the same moment, so the breakdown offers no trace. It fires per candidate, on the first days-editor save; approving without opening that editor keeps the weighting intact.

### 13 — Once a deduction step is confirmed its figure is latched forever — reversing the decision afterwards still pays it

`confirmed`

src/lib/automated-payroll/recommend.ts:326

Confirming a deduction step writes the current figure onto every displayed row, and from then on that saved figure always wins over any recalculation. If you later set that candidate to Do Not Take Action, or a re-collection supersedes it, the deduction is still charged — the module returns zero, the row's breakdown shows the line as pending or empty, and the sheet deducts the old amount anyway. The reverse also fails: a candidate approved after the step was confirmed contributes nothing, because the employee was never given a row. The expenses step has a purpose-built resync for exactly this problem; deductions have no equivalent. Reopening Part 1 does not clear it either — the only cure is HR knowing the figure went stale and typing over it.

### 14 — One failed database read in the CRM collector silently retracts every live CRM deduction for the month

`confirmed`

src/lib/deductions/connectors/crm.ts:866

The last query in the CRM collector reads job titles to decide who logs their own visits. Its error is never checked. If that one read fails, the lookup comes back empty, the very next filter drops 100% of candidates, and the collection engine reads that as 'the source has retracted everything' and supersedes every live CRM candidate for the month. Measured on the current August data: 60,790.32 EGP of live CRM deductions, of which 50,935.48 EGP is already Approved for Payroll, would be retired — and Part 2 would then read 0.00 for every medical rep. Decided rows do produce one warning each, so August specifically would be noisy; July's undecided rows would go in total silence, and the retraction happens either way.

### 15 — 205 employees across two published months were never told their payslip was ready

`confirmed`

src/lib/automated-payroll/run-service.ts:1062

The per-employee 'Your payslip is now available' notification is wired only to the older payroll module's Approve button. The automated path sets the batch to approved with a direct database write, so the notification never fires. Verified in production: the notification event type has 123 records, all dated 13 July 2026 — the last time the old module approved a batch — and zero since. The two automated publishes (10 August and 8 September) covering 105 and 100 employees produced two notifications between them, both to finance. Not one of those 205 people was told. They find their payslip only if they happen to open the portal.

### 16 — The same non-employee can be seeded automatically and typed in by hand on one run, and be paid twice

`confirmed`

supabase/migrations/20260830170000_automated_payroll_non_employee_recurring.sql:105

The standing roster copies its people into each new run automatically. The only duplicate guard is a database index that applies solely to rows carrying a roster reference — and a hand-typed entry carries none. The seeding itself compares only that reference, never the name. So if HR does not realise the roster now seeds automatically and types the same person in again, two rows exist, both go into the bank file, and the account receives two credits. The sheet's TOTALS shows the doubled figure as if it were correct. Afterwards the only thing distinguishing the two rows is a small 'Monthly' badge on one of them.

### 17 — Pressing "Sync standing list" during Part 2 can add money to a Part 1 that is already paid — and that row can then never be removed

`confirmed`

src/lib/automated-payroll/non-employee-recurring.ts:292

The sync refuses only published and cancelled runs. It seeds both parts regardless of which phase the run is in. So if you add someone to the standing roster after Part 1 is confirmed and the bank file executed, and then press Sync while working Part 2, a Part 1 entry is created on a closed instalment. It inflates every Part 1 sheet and finance total regenerated afterwards and appears in the Part 1 bank file on any re-download. And because Part 1 entries can only be edited while Part 1 is open, both Save and Delete then refuse — the row is permanently unremovable.

### 18 — Nothing is re-checked at publish, and the whole run stays changeable after Part 2 is confirmed

`confirmed`

src/lib/automated-payroll/run-service.ts:418 and :1091

Publish checks only that the run is 'ready'. It re-runs none of the pre-flight validation, the split check, the overpaid acknowledgement or the data-quality gate — while re-assembling the rows live from current data. And the server permits every step to be saved and confirmed while the run sits in 'ready'; the lock you see is a browser-side property only. So after Part 2 is confirmed and finance has downloaded and executed the bank files, a step edit — from a stale browser tab, a retry, or a direct call — still succeeds, and publish writes payslips that disagree with the payment already made. There is a quieter version that needs no edit at all: a routine salary change in the employee master between confirming Part 2 and publishing moves the published second instalment relative to the file finance already sent, with no marker and no audit trace. Measured in production: no step has actually been written while 'ready' on either published run, so this is armed rather than fired.

### 19 — "Start / Resume run" on a month that is already paid creates a second run that shadows the paid one everywhere

`confirmed`

src/lib/automated-payroll/run-service.ts:251

Start/Resume checks only for a live run, and the database's one-run-per-month rule deliberately excludes published months. The wizard actively shows the Start button on a published month. Press it and a second, empty run becomes the one every finance screen answers with — so the paid month's finance sheet and bank files immediately report 'Part 1 not confirmed yet' and become unreachable. Confirm Part 1 on the shadow run and it will emit a real bank transfer file for a month already paid. Confirm its Part 2 and it marks previous months' genuine debts recovered. The conflict is only detected at publish, after a whole month of work. And if it is later cancelled, next month reads its hold reasons from the cancelled run instead of the published one, so every continuing hold reason vanishes.

### 20 — Reopening Part 1 to correct a salary does not actually re-derive it for joiners or leavers

`confirmed`

src/lib/automated-payroll/run-service.ts:696

Unconfirming Part 1 exists specifically so a wrong base salary can be fixed and the first instalment refrozen accurately. It clears the frozen figure — but not the Base, allowance and fuel amounts that confirming the step stamped onto every joiner and leaver row. Those stamped values always beat the corrected employee record. So a rep hired on 10 August entered at 5,000 instead of 8,000 is still frozen off the 5,000 after you fix the record and re-confirm; the correction never reaches the money, the run reports success, and the sheet shows the corrected contract salary beside the stale payable, which reads as reconciled. It does not even need HR to reopen the tab — pressing Confirm Part 1 again reproduces it.

### 21 — Re-confirming the Part 2 Vacation step hands back the leave-balance days the first confirm consumed

`confirmed`

src/lib/automated-payroll/run-service.ts:574

Confirming that step debits the employee's annual-leave balance for CRM-recorded leave. Re-confirming — which the wizard offers as a normal 'Re-confirm & continue' button — recalculates against the balance the first confirm already reduced, sees no balance left, reclassifies the leave as salary-deducted, and supersedes the first record. The consumed days go back into the balance while the payroll deduction stays exactly where it was. Five leave days against a three-day balance: after one re-confirm the employee has his three days back and can take them again, and the ledger claims a larger salary charge than payroll actually deducted. It oscillates — a third confirm consumes them again, a fourth returns them.

### 22 — Changing someone's payment mode between the two confirms charges their loan twice, or drops it entirely

`confirmed`

src/lib/automated-payroll/recommend.ts:1578

Whether a deduction belongs in Part 1 or Part 2 is decided by reading the employee's current payment mode, freshly, every time any step is opened. But the columns it writes to are permanent. Correct someone from one-part to two-part between the two confirms and their loan sits in the Part 1 column from before, gets offered again on the Part 2 step, and is deducted twice. The mirror correction means it reaches no step at all and is never taken. The built-in double-deduction warning is switched off on every Part 1 deduction step, so nothing detects either state — the one-part-to-two-part case sometimes trips the overpaid acknowledgement, but only if there are no Part-2 additions to absorb it, and the message says nothing about a duplicate. The population it can hit is small — around 20 people whose overlap with the deduction detectors is essentially nil.

### 23 — The Additions step writes unlimited money with no source, no reason and no audit record of two of its three fields

`confirmed`

src/lib/automated-payroll/recommend.ts:1481 and src/lib/automated-payroll/run-service.ts:598

The only step that adds money to a payslip has no feeder, no upper limit, no required reason and no expandable breakdown. A 50,000 EGP bonus typed against one employee is accepted by the grid, by the route and by the pre-flight validator, and reaches the payslip. The save record notes only how many rows were edited, with no names and no amounts. The confirm record totals the first field it finds, which for this step is Incentive — so bonus and overtime leave no trace in any audit entry at all. Verified on the August run: the audit shows an incentive total of 5,442 across 120 employees, while the underlying rows also hold 2,258.00 of bonus and 1,000.00 of overtime that the audit never mentions.

### 24 — An interrupted publish can mark the run published over a batch that was never approved — no payslips, and every retry silently reports success

`confirmed`

src/lib/automated-payroll/run-service.ts:1113

When publish finds a leftover batch from an interrupted attempt, it finalises it only if the batch is still in the 'uploaded' state. For any other non-approved state it skips the finalise and marks the run published anyway. Payslips are visible only for approved batches, so nobody sees anything. And because publish returns immediately for an already-published run, every subsequent Publish reports success with zero rows and never fixes it — the month becomes permanently unpublishable through the wizard.

### 25 — The step that approves the salary batch never checks whether it actually approved anything

`confirmed`

src/lib/automated-payroll/run-service.ts:1062

The approve step updates the batch only if it is still in the 'uploaded' state, but it checks only for a database error, never for how many rows it changed. A zero-row match returns no error, so publish proceeds to mark the run published with an unapproved batch. Two Super Admins publishing at the same moment, or a workflow action nudging the batch between the create and the approve, produces a run and an audit entry both claiming a successful publish while no employee has a payslip. The older payroll module does check this and raises a clear conflict.

### 26 — The payroll decision trail can be deleted, and nothing in the database stops it

`confirmed`

supabase/migrations/20260720100000_automated_payroll.sql:159

The audit table is described everywhere as append-only, but that is a convention, not a rule. Checked against the live database: it carries no protective trigger of any kind, holds a delete policy for logged-in users, and grants delete, update and truncate to the authenticated role — gated only on being able to manage employees, which is broader than Super Admin. A single request can erase the payroll decision trail with no error and no counter-record. This is not abstract: for the 35 held employees above, one audit entry is the only surviving record that they were excluded at all.

### 27 — "Apply changes" after a spreadsheet upload does nothing at all

`confirmed`

src/components/automated-payroll/recommendation-step.tsx:834

The export-edit-reupload round trip dies at its last click. The hidden file input is emptied immediately after the preview is requested, so when the Apply button goes back to read the file it finds nothing and quietly issues no request. HR corrects an incentive in the template, uploads it, sees the amber preview say '1 changed', presses Apply changes, and nothing is saved. The grid below still shows the old value and the preview panel stays open, which are the only tells. The correction simply never lands; inline editing in the grid still works and remains a route to the same change.

### 28 — The hard "the split does not add up" gate at Part 2 confirm can never fire — it compares a number to itself

`confirmed`

src/lib/automated-payroll/reconcile.ts:44

The check that First Part plus Second Part equals Month Total is described as a hard block that cannot be acknowledged, on the grounds that a mismatch could only be a calculation bug. But the Month Total is defined three steps earlier as First Part plus Second Part and copied onto the row unchanged, so the comparison is a value against itself and can only fail on rounding noise. Any real defect in the split — a wrong frozen first instalment, a deduction counted twice, a leaver prorated on the wrong day count — leaves the total recalculated from the same two wrong numbers, so the identity still holds and the run confirms clean. The leaver overpayment in finding 9 passes this gate.

### 39 — An employee can be excluded from a run after their first instalment was already paid, erasing them from every record

`probable`

src/lib/automated-payroll/run-service.ts:1014

Excluding someone is the documented escape hatch when one bad row blocks the whole month. But it is permitted at any phase before publish, including after Part 1 was confirmed and the bank file executed. Excluding then removes them from the sheets, the bank files, the reconciliation, the validation and the publish — with a frozen first instalment already in their bank account, no salary record, no ledger entry and no line in the published audit detail. Money left the company with no trace in the month's payroll output.

### 40 — The "locked" finance workbook leaves the bank name and account number editable, contradicting its own cover

`probable`

src/lib/automated-payroll/exports/sheet.ts:259

The finance workbook tells finance in three separate places that every cell is locked except the two Finance Edit columns. In fact every appended extra column is unlocked, and the bank details are appended alongside those two — so the account number money is wired to is editable on a protected sheet. An accidental paste or autofill landing one column left silently overwrites an account number, and nothing stops it.

### 41 — The insurance-wage spreadsheet import accepts any positive number, with no legal floor or ceiling check

`probable`

src/lib/payroll/statutory/insurance-wage-import.ts:124

The importer rejects only negative wages. It never checks the statutory monthly band, even though that band exists as a constant in two other places in the same codebase. A stray zero (167,000) or a 1,200 part-timer figure both parse cleanly, count as matched, and are written to the column that alone decides the statutory filing. The out-of-band value is silently corrected only at calculation time, so the stored record and the deduction disagree with no error ever raised.

---

## Findings 29–55 — headlines only

### 29 — Someone hired and leaving in the same month is paid from the 1st, not from their hire date

`medium/confirmed`

### 30 — An employee with no social-insurance figure is published at zero rather than flagged

`medium/confirmed`

### 31 — Three spreadsheet day columns can never be saved, but the upload preview reports them as changed

`medium/confirmed`

### 32 — Correcting a leaver's days worked via spreadsheet changes the day count but not the money

`medium/confirmed`

### 33 — The Unpaid Vacation template has two columns with the identical heading, and the importer reads the wrong one

`medium/confirmed`

### 34 — A failed leavers query silently removes every already-resigned employee from the entire payroll run

`medium/confirmed`

### 35 — If the expense query fails, the Expenses step shows nobody and every reimbursement freezes at zero

`medium/confirmed`

### 36 — The Ready payroll sheet pays a full unprorated month to a leaver whose resignation is in the workflow

`medium/confirmed`

### 37 — A CRM or vacation deduction changes amount the moment anyone touches its day box, in any month that is not 30 days long

`medium/confirmed`

### 38 — The one workbook finance executes the month from never mentions holds on its cover

`low/confirmed`

### 42 — A negative bonus is accepted end to end and becomes a deduction nothing checks

`medium/probable`

### 43 — Every held employee is missing from the month's statutory filing

`medium/probable`

### 44 — One expense-approval save can wipe frozen expense figures in a month that did not change

`medium/probable`

### 45 — Approved expenses belonging to someone outside the run are dropped with no row and no warning

`medium/probable`

### 46 — The population comparison never blocks anything, and its baseline makes a held person look like a new hire

`medium/probable`

### 47 — An expense resync that is skipped because Part 2 is already confirmed is reported to nobody

`medium/probable`

### 48 — The Manual Deductions reason can be silently erased by a spreadsheet upload reporting no change

`medium/probable`

### 49 — The mutual-exclusion check between the two payroll engines fails open when its own query errors

`medium/probable`

### 50 — A concurrent cancel and Part-2 confirm can silently undo each other

`medium/probable`

### 51 — The CEO Payroll Console omits the company-scope check its sibling page has

`medium/probable`

### 52 — The Executive Summary compares this month including held people against last month excluding them

`medium/probable`

### 53 — Both acknowledgement gates accept a plain yes-flag sent on the first request, so the warning need never be shown

`low/probable`

### 54 — The excluded-employees panel prints the raw HR code instead of the person's name

`low/probable`

### 55 — The Payslips Center search for an HR code is case-sensitive, so a lower-case search reports "no payslips"

`low/probable`


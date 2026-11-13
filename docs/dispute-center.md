# The Dispute Center

One screen over the three dispute modules, for both sides — built 9 October 2026 on the owner's
instruction. The hooks live in `.claude/rules/payroll.md` and `.claude/rules/time-off.md`; this is
the account behind them.

## What he asked for

> "in the deductions and calendar disputes, I want to add in both modules an AI assist that works
> exactly as you work in here. He tell me what happened in details so he can make me able to detect
> any fraud… and be able to reply on any question first without re-getting back to any data but he
> must be accurate hundred percent… I want the both dispute modules to be able to approve, reject,
> decide, open a conversation, wait for their conversation, upload a picture in both and everything
> is saved nothing disappears… dispute closed dispute open but never disappeared from me or the
> employee side… And something you are forgetting, the weekly digest disputes."

His answers to the six questions that followed, each asked as multiple choice:

| Question | His answer |
| --- | --- |
| Who gets the case briefing? | **Only me** — Super Admin, nobody else |
| How does a decided case reopen? | **The employee asks, the reviewer reopens** |
| How long does a case wait for a reply? | **Wait, no deadline** |
| What outcomes does a deduction dispute have? | **Accept / Reject / Reduce** |
| A dispute won after its month was published and PAID? | **Reopen anyway** — "احتمال رد خصم الشهر القادم" |
| Where does the money come back? | **"in additions , other"** — next month's Additions → Other Additions |

## The three modules it covers

| Kind | The record it argues with | Its reviewer | Its own screen |
| --- | --- | --- | --- |
| `calendar` | a day in the Private Calendar | Super Admin only | `/admin/private-calendar-disputes` |
| `deduction` | a deduction on (or bound for) a payslip | Super Admin decides; CEO, Finance Manager and HR Operations read | `/admin/deductions?tab=disputes` |
| `digest` | a flagged day in the weekly attendance review | Super Admin and the named reviewers | `/attendance/disputes` |

Each module keeps its own record, its own decision and its own audience rule. The Dispute Center is
a second surface over all three — `/admin/disputes` for a reviewer, `/employee-portals/disputes` for
the employee — not a replacement: the three live queues stay, and every notification link already in
the wild still lands where it did. What the Center adds is the thing none of them had: a **decided**
case is still readable, by both sides, for ever.

Since 7 November 2026 the two module inboxes also DECIDE, not only reply (owner: "today I do not
have the option except reply"). The deductions Disputes tab shows the Dispute Center's own decision
panel on every card — the same case, the same route, the same accept / reduce / reject and reopen —
so what the money becomes is still decided in one place. The calendar inbox shows Accept and Reject
on every card instead of behind a "Review" button.

## Nothing is stored that can go stale

The state — waiting on the reviewer, waiting on the employee, reopen requested, decided — is
**derived** from the conversation and the events every time it is read
(`src/lib/dispute-center/state.ts`). That is deliberate: the three old screens disagreed about
whether a dispute was open because each kept its own flag. Nothing expires and nothing closes itself
(his "wait, no deadline"), so a case always names a person, never a clock.

`dispute_case_events` is append-only and carries every decision, reopen request, grant, decline and
refund movement with its actor and its note. A case's history is readable even where the module's own
row has been overwritten.

## The decision, per kind

- **Calendar** — accept (the correction is shown on the day) or reject.
- **Weekly review** — uphold (the day is not deducted) or reject (it is, by the method the employee
  chose). A SECOND decision is a **revision**: the settlement row is immutable, so
  `phx_attendance_revise_digest_dispute` moves the LINE and reverses the leave charge in one
  transaction, and for a dispute outcome the line becomes the truth
  (`effectiveSettlement`, `src/lib/attendance/digest-rules.ts`). The month-end bridge and the
  Deductions module's own "was this day already cleared?" guard both read through it — the hole this
  closes is a day upheld, then reopened and rejected, still being treated as upheld by payroll.
- **Deduction** — **accept** cancels it (Do Not Take Action), **reject** keeps it, **reduce** charges
  the days he types. A line already on a payslip is **withdrawn first** and then re-decided in the
  same click, because `recordDecision` refuses a candidate locked by a publication. The figure is
  always re-derived server-side from what the database holds; the browser never does payroll
  arithmetic.

## Disputing before the money is taken (13 November 2026)

> "make the employee able to dispute in the deduction module and if approved the dispute fix his
> deduction and calendar and deduct if reject then detect"

Until this date an employee could only reply on a deduction already pushed to the payslip (his
ruling of 9 October). Two things had moved under that rule: the push gate was retired on 7 October,
so an "Approved for Payroll" deduction is charged whether or not it was pushed — and could not be
argued with — and his new words put the dispute before the money. Now:

- **Who may dispute** — any deduction the employee sees except a cleared one ("Do Not Take Action").
  One rule, `deductionOpenForDispute` (`src/lib/deductions/dispute-open.ts`), asked by the server
  gate (`addDeductionsComment`, `addDeductionsReply`), the portal row and the HR inbox. The portal box
  reads "Dispute this deduction" and tells him what each outcome does.
- **The HR inbox** lists a disputed deduction with no pushed line too, with a line built from the
  candidate (`unpublishedDisputeLine`); an undecided one reads "Not decided yet — rejecting the
  dispute deducts it".
- **Reject on an undecided deduction** records "Approved for Payroll" at what was detected and pushes
  it (`decideDeductionDispute`). Leaving it Pending would charge nothing, so "the deduction stands"
  would have been a sentence, not a figure. **Reduce** on one is capped by the detected figure.
- **Accept fixes the calendar** — every day of a deduction whose dispute stands accepted (newest
  `decided` event is an accept, no reopen since) AND whose decision still reads Do Not Take Action
  becomes the same ✓ Verified entry an accepted whole-day review request makes, which clears the
  day's "No Activity Recorded" finding (`src/lib/dispute-center/accepted-deduction-days.ts`, fed into
  `buildAcceptedCorrectionItems`). It is display only and read best-effort; it is NOT a deduction
  source — the accepted candidate itself is what stops the charge. A reduce verifies no day (it names
  none), a reject verifies nothing.

Pinned by `tests/deduction-dispute-outcome.test.ts`.

## Disputing a released daily deduction (13 November 2026)

> "IN DEDUCTION MODULE IN EMPLOYEE PORTAL NO DISPUTE OR COMMENT BUTTON"

The employee's Deductions page lists the daily deductions the Super Admin released during the month
above the monthly ledger, and those lines had no Dispute box. On 13 November seven employees held a
released line and four of them had nothing on the monthly ledger, so the release email sent them to
a page where they could not argue with the amount. Asked what accepting such a dispute should do, he
chose **"Withdraw + never charge"**.

- **The box** sits under every released line ("Dispute this deduction"). One dispute per line
  (unique on `line_id`); a decided one is reopened through the Dispute Center, never opened twice.
  `POST /api/daily-deductions/disputes` checks the line is in the ACTIVE released snapshot and is the
  caller's own.
- **The case** is kind `daily` in the Dispute Center. `daily_deductions_disputes` keeps its own copy
  of the line (days, amount, dates, reason), because withdrawing a line deletes it and a superseded
  snapshot cascades its lines away. Messages live in `daily_deductions_dispute_messages`. The owner
  is the employee, matched on the compact HR id; the Super Admin decides (he alone releases a daily
  line); the Deductions module's readers may read.
- **Accept** withdraws the line (`withdrawDailyLine`) and the days are never charged again for that
  employee and that category. Both month-end collection doors in `src/lib/deductions/collect.ts` and
  the daily tally (`runConnectorForRange`) pass their drafts through `applyAcceptedDailyDisputes`
  (`src/lib/daily-deductions/accepted-dispute-days.ts`): a draft wholly on won days is dropped, an
  exact one-day-per-date draft is narrowed and re-priced through `scaleDeductionAmountToKeptDates`
  (a CRM Thursday keeps its half-day weight), and a draft whose day count differs from its dates (a
  vacation request) is kept and named in a note for a hand narrowing. The read **fails closed**: if
  the disputes cannot be read, collection stops rather than charge a won day.
- **Reject** keeps the line; it is charged at month end like any other.
- **No reduce** — a released line is withdrawn whole or it stands.
- **The calendar** — every day of an accepted daily dispute is a ✓ Verified entry on the Private
  Calendar (`selectAcceptedDailyDisputeCorrections` in `accepted-deduction-days.ts`), display only.
- **Reopen** puts the status back to `open`, which lifts the spare and the ✓ with it.

Pinned by `tests/daily-deductions-disputes.test.ts`. Migration:
`supabase/migrations/20261113181500_daily_deductions_disputes.sql`.

## Money owed back after a paid month

A published, paid month is a record of what was paid. It is never rewritten to agree with a later
decision. So when a reopened dispute cancels or reduces a deduction whose month is already paid, the
difference becomes a row in `dispute_refunds` with the first month whose payroll is still open as its
target, and the Additions step pre-fills **Other Additions** with it and its reason
(`src/lib/automated-payroll/dispute-refunds.ts`). It is a RECOMMENDATION: HR sees the figure with the
month it gives back and confirms the step, exactly like the standing additions register, and a value
HR saved always wins. Deciding the case the other way a second time **cancels** the recommendation
rather than clawing back a payment.

The opposite direction has no automatic answer and must not be invented: a weekly-review day upheld,
then revised to rejected after that month was paid, raises a NOTICE on the decision —
"that month is already paid, so this day cannot be charged in it; decide where it is taken in
Automated Payroll" — instead of silently charging it to a different month.

### What "charged before" means, and six ways it was wrong (fixed 2026-10-09)

Every money sentence on a deduction dispute is `charged before − charged after`, so the whole screen
rests on one question: what does this deduction charge? The answer is its **decision**, never its
publication line — owner, 2026-10-07, in `buildDeductionBuckets`: *"a candidate counts iff its
decision is 'Approved for Payroll' … Whether the line was pushed is not read here at all."* The
dispute path read the LINE, and the two disagree in both directions:

1. **A refund of nothing.** Approved but never pushed means no active line, so "charged before" read
   0.00 and a dispute the employee WON gave nothing back while payroll charged the month in full.
   `payrollCharge` (`src/lib/dispute-center/deduction.ts`) now asks payroll's own `candidateAmount`
   and `isConfirmedForPayroll`, so one person's money never has a second opinion.
2. **A refund twice over.** A line withdrawn by an earlier decision read 0.00 the same way, so the
   next decision looked like money going back and recommended a second refund on top of the live one.
3. **A "reduce" that raised the charge.** The ceiling was the line's days, or — with no live line —
   the DETECTED days, the one figure nobody has decided: a deduction already cut to 1 day in the
   workspace could be "reduced" to 3 of its 4 detected days. The ceiling is now what it charges now,
   and a deduction charging nothing cannot be reduced at all.
4. **A reject that changed nothing.** "The deduction stands" was a message and not a figure: after an
   accept was reopened and then rejected, the module still held Do Not Take Action, payroll charged
   nothing, and the refund from the accept stayed live. A reject now restores the charge recorded by
   this dispute's FIRST decision event (`chargedValueBefore` — the decision row is overwritten each
   time, so the event trail is the only record of what it charged before) and pushes the line back.
5. **A second decision with no reopen.** Nothing refused one, and each decision measured what it owed
   against what the last one left. `isDecidedByEvents` now refuses it in the same words the weekly
   review uses, and the decision panel no longer offers the buttons while a reopen is only requested.
6. **A unique violation after the money moved.** `recommendDisputeRefund` discarded
   `cancelLiveRefund`'s answer, so a case whose earlier refund had already been PAID hit
   `dispute_refunds_one_live_per_case` (23505) *after* the decision was recorded. It now recommends
   nothing, says so, and hands HR the difference to settle.

And one on the same path that is not about a figure: a `recordDecision` that fails **after** the line
was withdrawn now puts the line back and names the state it leaves behind, instead of reporting a
plain failure while payroll charges a figure the portal no longer shows.

**The weekly-review side had the same first defect, and it bit harder there.** `digest-money.ts` read
`chargedBefore = line?.appliedAmount ?? 0` for the month-end fingerprint deduction behind a disputed
day. On that path "approved, not yet pushed" is the *ordinary* state of a day for days at a time —
the bridge approves the candidate when the month closes and the push is a separate act — so a day
upheld inside that window gave back **0.00** while payroll charged it in full. The rule now lives
once, in `src/lib/dispute-center/charge.ts`, and both paths ask it: two copies of "what does this day
cost" are two answers to one person's money. `activeLineFor` deliberately no longer returns an amount
at all — the line says whether the employee can SEE the deduction, nothing more.

### The refund had to survive the Additions confirm

`confirmStep` persists every visible row, so the first Additions confirm wrote
`other_additions = 0.00` for the whole population — and `pick` in `recommend.ts` prefers a saved
figure over the feeder for ever. A refund recommended after that confirm could appear nowhere: not on
the step, not in the drift report, not in the Part 2 gate. The money was owed and nothing could pay
it.

`p2_additions` is now on `MODULE_SOURCED_STEP_KEYS`, the repo's own answer to exactly this shape of
problem: the confirm records what the feeder was proposing at the time, so a zero nobody chose is
told apart from a figure HR typed. The refund swaps back onto the row
(`takeCurrentModuleFigures`), the Part 2 confirm refuses while confirming would pay the month without
it, and a save no longer stamps an untouched 0.00 as somebody's own figure. One consequence worth
knowing: a saved **zero** in Other Additions never suppresses the refund's reason, because without a
reason the re-confirm that block asks for was refused outright by `assertAdditionsReasonsPresent` —
money with no explanation. A zero explains nothing and needs no explanation of its own; a figure HR
actually typed still suppresses it.

## One decision at a time, all or nothing (13 November 2026)

Enterprise audit finding F-PAY-005. A deduction dispute's decision is several writes: the payslip
line comes off, the decision is written, the smaller figure goes back on, and a refund is recommended
or cancelled. The "decided" event is written last. Before this change, the "already decided" gate was
a plain read in front of all of them. Two decides could both pass it, and a failure part-way left the
case reading open while payroll already charged the new figure.

`decideDeductionDispute` (`src/lib/dispute-center/deduction.ts`, helpers in `decision-claim.ts`,
migration `20261113162318`) now works like this:

1. **Claim.** `phx_claim_dispute_case_decision` claims the case in one statement before anything is
   written. A second decide meets the live claim and gets a Conflict. A claim left by a request that
   died lapses after 5 minutes (`DISPUTE_DECISION_CLAIM_LAPSE_MINUTES`; the SQL carries the same
   figure).
2. **Re-check.** "Already decided" is asked again under the claim.
3. **Before-state.** The before-state of everything the decision may touch is captured and stamped on
   the claim.
4. **What each write left.** After every write, the state is read again. The decision is pinned to the
   `updated_at` its own write returned, for every later read too. So a write somebody else makes in
   between is never taken as this decision's own.
5. **Claim still held.** Just before the last write, `phx_renew_dispute_case_decision` proves the claim
   is still held by this token and renews it. Stamp, renew and release by token all throw the
   claim-lost Conflict when they touch no row, never a silent success.
6. **Last write.** The refund events and the "decided" event go in one insert, as the last write.

**On a failure after the first write** (a lost claim included),
`phx_restore_deduction_dispute_state(before, left, actor)` runs in one transaction. A row is put back
only while it still equals what this attempt left.

The claim stops other dispute decisions. It does **not** stop the Deductions workspace or a month
push. So if anybody changed a row in between, the undo puts back nothing: it names the rows, and writes
a `dispute_decision_undo_refused` audit row.

All or nothing, because a half-undo is another half-state, and the one-active-line and
one-live-refund indexes would refuse most mixes anyway. Every line and refund statement is scoped to
this candidate and this case.

**Where the undo fails or refuses**, a `decision_interrupted` event marks the case **Needs attention**,
with the contested rows in its details. A lapsed claim that still carries a before-state is marked the
same way.

**The decision history.** The history trigger `phx_deductions_decisions_history`
(`20261113151739_deduction_decision_history.sql`) records inserts and updates only. So when the undo
deletes a decision row that did not exist before, it writes that history row itself, in the trigger's
own detail shape: action `decision_removed`. The trigger is never changed or disabled.

**A step whose outcome is unknown.** A step can throw after it has already committed, because the
reply was lost. Its re-read can also fail. Either way nothing can tell whether the step changed
anything. The undo still puts back what is known, but the reviewer is never told "put back": the case
is marked "needs attention" and the event names the step.

The earlier refund is cancelled as its own step, before the new one is recommended. So a failed insert
can no longer leave the earlier refund cancelled behind a "nothing changed".

When the last insert (the `decided` event) fails, the timeline is read first. If a `decided` event new
since the claim is there, the decision was recorded and is answered as made, with nothing undone. If the
timeline cannot be read, the outcome is unknown.

The marker's details (HR ids, notes, refund rows, error text) are stripped from the employee's case
payload (`eventsForViewer`).

**A payroll step re-opened by the failed attempt is not undone.** HR re-confirms that step in the
month's Automated Payroll run, and its figures recompute from the restored decision and lines.

**What cannot be put back:**

- `updated_at` is stamped again on any restoring write.
- A publication row created by the failed attempt stays, with zero lines. `deductions_audit` refers to
  it and is append-only.
- The audit trails stay.
- Publication lines and refunds carry no revision column. So a change somebody else makes in the
  instant between this attempt's write and its re-read is taken as this attempt's own.

Pinned by `tests/dispute-and-deduction-atomic.test.ts`.

## The case briefing

Super Admin only (`assertAssistActor`). It reads the case's own records — the day's calendar
evidence, the figures, the whole conversation, the history — numbers them, and asks the model to state
what they show, with every statement naming the fact numbers it rests on.

Then it **checks the answer** (`src/lib/dispute-center/assist-verify.ts`). A statement that cites no
fact is dropped. A statement whose times or figures do not appear in the facts it cited is dropped.
The count of dropped statements, and the reason for each, is shown on the screen rather than hidden —
a hedged invention is indistinguishable from a finding, and this screen is where one person's pay is
decided. Every surviving statement is rendered beside the records it cited, because the one thing the
verifier cannot catch is a sentence whose words are wrong while its numbers are right.

Each briefing is saved with a fingerprint of the facts it was built from, so re-reading an old one
says "the case has changed since this was written" instead of reading as current.

The model is told, in as many words, never to accuse anybody and never to use the words fraud, lying,
guilty, innocent or suspect. It describes records; the judgement is the reader's.

## Pictures

Either side may attach up to four pictures to any reply (his "upload a picture in both"). Calendar
and weekly-review pictures live in the private `dispute-attachments` bucket and are served only by
`/api/dispute-center/attachments/:id` after the participant check; deduction pictures keep the store
they were given on 8 October (`deductions-dispute-attachments`). Every picture goes through the one
sniffing rule (`checkDisputeImage`), so a file refused on one dispute screen can never be accepted on
another. The storage key is the case plus the picture's own uuid — an uploaded file name never reaches
it.

## The gate

The routes are registered on `attendance:read`, which only decides who reaches the ROUTE. Who may
read or write a given CASE is each module's own rule, applied per case by
`src/lib/dispute-center/participants.ts`: the employee it belongs to, that module's reviewer, and for
deductions the company-wide readers who may read and not write. A named weekly-review reviewer never
rules on their own pay; the Super Admin is exempt, because nobody is above him. A line manager
holding `attendance:read` opens the page and sees nothing of a rep's pay-affecting dispute.

## What it is pinned by

| Test | What it refuses |
| --- | --- |
| `tests/daily-deductions-disputes.test.ts` | a released daily line with no Dispute box, a won day charged again by either month-end door or the daily tally, an open or rejected dispute sparing a day, a reduce on a daily case |
| `tests/dispute-center-state.test.ts` | a stored state, a case that expires, an employee reopening their own case |
| `tests/dispute-center-participants.test.ts` | a case readable on `attendance:read` alone; a decide or reopen that does not assert the participant inside the domain helper |
| `tests/dispute-center-assist-accuracy.test.ts` | a statement with no citation, or with a figure the cited records do not hold; a stale briefing read as current |
| `tests/dispute-center-digest-revision.test.ts` | a reader of a settled day that answers from the first decision for ever; the day's cost read off the payslip line instead of the decision, a candidate read missing the columns that rule needs, and a line helper carrying a money figure again |
| `tests/dispute-center-refunds.test.ts` | a refund paid twice, a cancelled refund paid, a published month rewritten, a storage key carrying a file name — and every one of the six money faults above: a charge read off the payslip line, a reduce measured against the detected figure, a reject that records nothing, a second decision with no reopen, a refund recommended over one already paid, a frozen 0.00 in Other Additions |

## The migration

`supabase/migrations/20261009120000_dispute_center.sql` — the `dispute-attachments` bucket and its
table, `attendance_digest_dispute_messages`, the append-only `dispute_case_events` and
`dispute_assist_entries`, `dispute_refunds` (one live recommendation per case),
`automated_payroll_draft_rows.other_additions`, reversing entries in
`attendance_annual_balance_charges`, and `phx_attendance_revise_digest_dispute`.

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
| `tests/dispute-center-state.test.ts` | a stored state, a case that expires, an employee reopening their own case |
| `tests/dispute-center-participants.test.ts` | a case readable on `attendance:read` alone; a decide or reopen that does not assert the participant inside the domain helper |
| `tests/dispute-center-assist-accuracy.test.ts` | a statement with no citation, or with a figure the cited records do not hold; a stale briefing read as current |
| `tests/dispute-center-digest-revision.test.ts` | a reader of a settled day that answers from the first decision for ever |
| `tests/dispute-center-refunds.test.ts` | a refund paid twice, a cancelled refund paid, a published month rewritten, a storage key carrying a file name |

## The migration

`supabase/migrations/20261009120000_dispute_center.sql` — the `dispute-attachments` bucket and its
table, `attendance_digest_dispute_messages`, the append-only `dispute_case_events` and
`dispute_assist_entries`, `dispute_refunds` (one live recommendation per case),
`automated_payroll_draft_rows.other_additions`, reversing entries in
`attendance_annual_balance_charges`, and `phx_attendance_revise_digest_dispute`.

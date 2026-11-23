# The approvals rebuild — Expense Approvals and Place checks

*23 November 2026*

Two screens decide things for real people every day: Expense Approvals (what a trip pays) and Place
checks (whether a customer's place is validated). The owner had both audited on 23 November 2026 and
then ordered both rebuilt. This is the account of that rebuild. Module rules live in
`.claude/rules/expenses.md`; this file holds the evidence and the reasons.

Part 1 (Expense Approvals) is written. Part 2 (Place checks) is added by the pull request that
rebuilds it.

## His words

- The audit, 23 Nov: "THEIR APPROVALS PAGE IS VERY TIME CONSUMING AND HARD", "DEEP AUDIT THE BOTH
  AND GIVE ME A VERY DETAILED HONEST SCORE PER ITEM THEN PER MODULE OUT OF 10".
- The order, 23 Nov about 02:30 Cairo, refusing a plan of fixes: "REBUILD FROM SCRATCH LESS THAN
  9.5/10 PER ITEM IS NOT ACCPETED".
- His choices, asked as multiple choice the same night:
  - Expense Approvals saves "at once, with Undo". This lifts his 14 Nov "Keep its batch save".
  - Place checks "approve the proven ones", and "the sign wins".
  - A reduced claim: "Stay silent as today". Only a rejection is told to the employee.

## The audit scores

| Module | Score | Items |
| --- | --- | --- |
| Expense Approvals | 4.8 of 10 | 18 |
| Place checks | 4.7 of 10 | 19 |

What the audit found on Expense Approvals, read on production that night:

- The page read every trip ever filed, 694 rows with every column, to draw the 64 that waited. The
  reviewer then made four more requests for each trip.
- 56 of the 64 waiting claims were flagged by the territory test, so "needs a look" said nothing.
- The field checks read iReports360 positions, which stopped arriving on 6 Nov 2026.
- "Approved" counted three different things. Of 230 trips shown as approved, 5 were held out of
  payroll and 98 had already been taken by a payroll.
- A decision wrote over the system's own reading of the claim, so nobody could ask afterwards
  whether the reading had been any good.
- 64 claims waited, 11 of them for trips before 7 Nov.

## Part 1 — Expense Approvals, the decision desk

### What it is

One line says how many decisions wait. Under it, five tiles that each equal a database count. Then
three lanes:

- **Ready**: every check that applies to the claim passed. One button approves the whole lane and
  shows the count and the total first.
- **Your call**: something failed or could not be checked. The row says the one reason.
- **History**: what was already decided. It is read only when it is opened, 50 at a time.

A decision is one press on the row. It waits six seconds, during which Undo takes it back, and then
it is sent. There is no Save button and nothing is kept in the browser. Opening a trip shows it
whole on one screen: what the system found, each day with its visits and one map, then the photos
and tickets, with Approve, Reduce and Reject pinned.

### Where the code lives

| Part | Place |
| --- | --- |
| The screen | `src/components/outstation/approvals-desk/` (14 files, the longest 331 lines) |
| The rules | `src/lib/outstation/approvals/` (16 files, the longest 358 lines) |
| What waits, and the press | `app/api/admin/outstation/approvals/route.ts` |
| One trip in one read | `app/api/admin/outstation/approvals/[requestId]/route.ts` |
| History | `app/api/admin/outstation/approvals/history/route.ts` |
| The kept verdict | migration `20261123024239_outstation_request_verdict_at_decision.sql` |

### The checks, and what they were measured against

`approvals/checks.ts` runs seven checks on a trip: field work, route, arrival photo, departure
photo, ticket, duplicate and amounts. A claim for a meeting or another cost runs two: duplicate and
amounts. Each check answers pass, fail or "could not check" in one sentence. "Could not check" is
never a pass. The system files a claim in a lane and never rejects one.

Each check was built on what the owner had actually decided, read on production on 23 Nov:

| What was measured | Approved | Rejected |
| --- | --- | --- |
| A departure photo with no flag | 50 | 11 |
| A departure photo "too soon" after the arrival photo | 25 | 7 |
| A departure photo far from the arrival photo | 18 | 9 |
| A departure photo outside the trip's days | 9 | 6 |

- "Too soon" was approved 78% of the time and "no flag" 82%. The difference is noise, so two photos
  taken together now pass and the length of the stay is read from the visits. 19 of the 47 photo
  pairs measured were 0 to 5 minutes apart.
- A departure photo outside the trip's days was approved only 60% of the time. That check stays.
- The old reading itself did not predict his answer: a claim it called "matched" was rejected 24% of
  the time, and one it called "no activity" 26%.
- What he rejected for, in his own written reasons: a duplicate, no field work, a medical rep's
  hand-typed claim the system never priced, and a meeting cost with no invoice. Each is a check.

Field work is read from Phoenix CRM: a visit that day in any role, a manager's own single visit, or
a recorded meeting. It is read once for all waiting trips (`approvals/field-evidence.ts`). A source
that could not be read gives "could not check" for every trip, never "idle".

### Where a trip stands

`approvals/standing.ts` gives one answer that every tile, lane and row reads:

| State | Meaning |
| --- | --- |
| Waiting | Not decided. |
| Approved · held | Accepted, but no payroll row carries it yet. The evidence gate is holding it. |
| Approved · next payroll | Accepted, a payroll row carries it, no payroll has taken it. |
| In payroll | A payroll took it. Nothing can change it here. |
| Rejected | Nothing is paid. |

The paid stamp on a payroll row is written only since 12 Sep 2026, and July and August 2026 were
never backfilled. So a row with no stamp whose payout month is August 2026 or earlier is in a
payroll, and the page says so.

### The press

`approvals/press-queue.ts` holds a press for six seconds. During that time the claim is off the list
and out of the waiting count, so it cannot be pressed twice. When the page is left, every press
still inside its window is sent. The server never reverses a decision.

`approvals/decide.ts` reads each claim again as it stands, plans the press, and hands it to
`applyOutstationRequestExpenseDecisions`. That is the same function the old screen used, so the one
payroll write, the version check, the evidence gate, the in-payroll lock, the audit row and the
employee's notice are all inherited. No money rule was written again.

Each claim in a press answers for itself: saved, changed, refused, or approved at a figure that was
not the one chosen. A claim that changed since it was drawn comes back to the list with its new
figures and the reason.

An approval is two writes: the claim, then its figure. "Saved" is said only when the claim now
stands in the state the press meant and at the figure it chose (`amountLanded`). Where the claim
reached the next payroll and the figure did not follow, `decide.ts` sends the same press once more.
If the figure still is not there, the answer is `amount_not_saved`: a red line by name that says the
amount was not saved and what the trip pays as it stands. A press the workflow refused as stale is
answered "changed" even when the claim now reads approved, because somebody else's press put it
there. Known limit: the desk has no button that repairs a figure that did not land; the red line and
the app's error table (`expense_desk_amount_resent`) are what say so.

When the answer itself is unclear, the page does not guess. A 5xx, or a yes whose body cannot be
read, means the decision may have landed: the page says so and reads the list again
(`readPressAnswer` in `approvals/press-queue.ts`). Only a 4xx, which is turned away before any claim
is read, is reported as not saved.

What is refused before anything is written (`approvals/decision-plan.ts`):

- a claim that is already decided, whatever the press and whatever version it carries;
- a claim a payroll already took;
- a press made on an older version of the claim;
- a rejection or a reduced amount with no reason;
- an idle-day cut that no longer holds, because a visit was recorded since;
- a reduced amount on a trip the payroll gate would hold. A held trip has no payroll row, and the
  payable figure lives on that row. The old screen approved such a trip, lost the figure and said so
  afterwards, and the trip later paid in full. The desk refuses it in words instead.

A decision needs a real signed-in Super Admin. The development preview identity and View as Seat can
read the page and cannot decide. The CEO can read it.

### The idle day

The 7 Nov rule stands: a trip day with no visit and no recorded meeting is idle, the per-idle-day
share of the allowance is cut before he presses, Approve names the cut and pays it, and "Keep full
claim" is one press. Opening a trip writes nothing. Travel and tickets are never cut.

Paying an idle day in full is always said out loud. Wherever the page knows of a cut and does not
send it, the press carries `keepFull`. An Approve that names no amount and does not carry it is paid
in full only while the server's own reading finds no cut either. If the server finds one, the claim
comes back as changed with the cut on its button. So a page that was read before the field work
was, or left open past midnight, cannot pay an idle day by its silence.

A batch sends each row's own Approve, so a batch pays the cut where a row names one. One kind of
trip is held back from every batch: a trip with an idle day that the payroll gate would hold. It
cannot carry the cut, so its own Approve pays the claim in full and the row says so. "Approve all"
and "Approve N" leave it out, name it, and keep it ticked so that it is opened and decided by
itself (`paysIdleDayInFull` in `approvals/desk-view.ts`). The server holds the same line: a request
that decides more than one claim is refused any press that carries `keepFull`.

### The kept verdict

When a claim is decided for the first time, two columns keep the system's reading as it stood:
`system_lane_at_decision` and `system_verdict_at_decision`. The write touches nothing else. It never
changes `updated_at`, which is the claim's version token. Nothing decided before 23 Nov was
backfilled, because those decisions were made on checks nobody kept.

The page shows the result under the tiles: over the last 30 days, how many Ready claims he approved
in full. A Ready claim he reduced or rejected is a miss. "Your call" has no right answer, so its
share approved is shown as a fact and never scored. The meter starts empty.

### No decided claim's money moves

The rebuild reads decided claims and never rewrites one. Nothing re-runs the payroll write for a
claim already decided, changes a payout month, or replaces an amount he typed with the claim's
total. On the day of the rebuild 26 claims carried his own typed figure.

Only a waiting claim is decided. A claim already approved or rejected draws no decision button
anywhere on the desk. History and its opened trip read it and say "This claim was already decided.
It is read here, not changed." The server refuses every press on one, before it even looks at the
version. After the six seconds of Undo, a decision is not changed on the desk. The 7 Nov screen
allowed that until a payroll took the trip; whether the desk should offer a guarded way to do it is
an open question for the owner.

### What the risk review found before the merge

The first build was reviewed for money and access on 23 Nov, before anything was merged, and the
verdict was not to ship it. Six findings, all fixed in the same pull request:

1. From History, Open offered "Pay in full", "Change amount" and "Reject" on a decided claim. "Pay
   in full" on a claim approved at EGP 900 of 1,200 wrote the typed amount to nothing and payroll
   would have paid 1,200. Decided claims are now read-only, on the screen and on the server.
2. A reduced amount on a rejected trip that would be held lost its figure. Closed by the first fix.
3. "Saved" was said when the claim was approved and its reduced figure had not landed. Now
   `amount_not_saved`, after one re-send.
4. A page read before the field work could approve an idle day in full without saying so. Now
   `keepFull`, and the server sends a silent Approve back when it finds a cut.
5. A server failure after the write was shown as "Nothing changed". Now the page says the result is
   unknown and reads the list again.
6. The version check on changing a decided claim's amount was weak. Closed by the first fix.

### What was not carried over

Each of these was on the 7 Nov screen and is not on the desk.

| Not carried | What is there instead |
| --- | --- |
| The Save button, the unsaved count and the draft kept in the browser | A press saves after six seconds of Undo. |
| Nine tabs and six tiles | Three lanes and five tiles. |
| The "By employee" roll-up tab | The search box narrows by employee. |
| "Unapprove back to waiting" | A decided claim is not reopened here. |
| Biggest first, and the order remembered for each reviewer | Oldest first, always. |
| The Data first / Map first switch | One scroll: the data, then each day's map. |
| "Expand all / Collapse all" and the details panel inside the row | Open shows the trip on the full screen. |
| The claim-validation panel | The checks on the row and in the opened trip. |
| The map legend table | A one-column legend under each map. |
| A batch held every pre-cut trip back | A batch pays each row's named cut, and holds back only a trip that would pay an idle day in full. |

The export still downloads every trip. It narrows by the search box only.

### What stayed where it was

- `app/api/admin/outstation/expenses/route.ts` stays. The Expenses sheets screen
  (`expenses-review-workspace.tsx`) saves through it, and so do the trips that came from the expense
  sheets before employees filed in Phoenix.
- The approval function itself is still in `src/lib/outstation/service.ts`. The desk calls it and
  does not copy it.
- "Add a missed stop" is in the opened trip, under the photos, as before.
- These have no screen that calls them since the rebuild and were left in place:
  `planBulkApproval`'s `needsPreCutTripIds`, `expenseApprovalQueueRank`,
  `EXPENSE_APPROVAL_VIEW_KEY_BASE`, `compareExpenseApprovalTrips`, `withLiveWorkloadStatus`,
  `reasonAfterIdleDayPick`, `src/lib/outstation/expense-approval-summary.ts`, the
  `expense-fraud-checks` library and its route
  `app/api/admin/outstation/expenses/[requestId]/validation/route.ts`.

### Tests

Nine new files pin the desk: `tests/expense-desk-checks.test.ts`, `-claim-row`, `-decision-plan`,
`-press-queue`, `-queue`, `-reviewer`, `-routes`, `-standing` and `-view`. The 18 tests that pinned
the 7 Nov screen were rewritten onto the desk, each keeping the rule it pinned. Every new assertion
was proven by breaking its fix and watching that assertion fire: 18 domain cases, 13 route cases,
24 screen cases, 52 carried-over cases and 8 batch cases. The look-over's fixes added 15 cases and
the risk review's fixes 17; all fired.

### What only time can prove

Three items of the audit cannot be scored on the day the page ships:

- that he approves at least 95% of what the page calls Ready;
- that the reasons on "Your call" match what he finds;
- that the median wait at decision falls under 3 days.

The page carries its own meter for the first. All three are read again 30 days after the merge.

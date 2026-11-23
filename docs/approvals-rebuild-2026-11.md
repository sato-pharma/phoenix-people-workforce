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

One line says how many decisions wait. Under it, six tiles that each equal a database count. Then
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
amounts. A claimed meeting also runs the Thursday check ("Filters and the Thursday flag", below). Each check answers pass, fail or "could not check" in one sentence. "Could not check" is
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
| Approved · next payroll | Accepted, a payroll row carries it, and the payroll of its payout month has not run yet. |
| Approved · payroll already ran | Accepted, a payroll row carries it, the row is not marked paid, and the payroll of its payout month has already run. |
| In payroll | A payroll took it. Nothing can change it here. |
| Rejected | Nothing is paid. |

The paid stamp on a payroll row is written only since 12 Sep 2026, and July and August 2026 were
never backfilled. So a row with no stamp whose payout month is August 2026 or earlier is in a
payroll, and the page says so.

**Approved · payroll already ran** was added the morning the desk went live (23 Nov 2026). The first
read of production after the merge found 12 approved trips, 3,869.30 EGP, with payout month September
(6) or October (6) 2026 and no paid mark, while both payrolls had run. The desk called them "Approved
· next payroll". That was not true: payroll reads a trip by its own payout month and no later run
looks back at an earlier one (`src/lib/automated-payroll/late-expenses.ts`), and the switch that
carries such trips into the next run was off.

Not every such trip is on the payroll Expenses step's list, and the desk does not say it is. That
list leaves out a person who was held in the month's run (his money is in the held balance that Held
Salary Release pays) and a trip the month's published figure already covered. Of the 12 trips, 11
(3,549.30 EGP) belonged to one person held in the September run; one (320.00 EGP, September) belonged
to another person. The first wording said "it is listed on the payroll Expenses step"; a review the
same morning found that untrue for the 11, and it was corrected before the label reached production.
The sentence now says the trip may have been paid another way and names the screen to check before
anything is paid.

How the state is read: the newest payout month that any payroll row carries a paid stamp for is the
last payroll that ran (`readLastPaidPayout` in `approvals/queue.ts`, one row). An approved trip
with a payroll row, no paid mark, and a payout month on or before that one is in this state. The
page never calls it unpaid, because a missing mark does not prove a missing payment (a stamp can
fail, and a person's published figure can differ from their approved trips). It says what is known
and names the screen. The state changes nothing: no payroll row is written and no amount moves.

On production that morning: 64 waiting, 5 held, 104 next payroll (49,710.97 EGP), 12 payroll already
ran (3,869.30 EGP), 109 in payroll, 64 rejected.

**Visit positions could not be read** was found the same morning, by calling the desk's own loader
against production. A district manager's own visit carries the screen label `own:<uuid>`; the desk
sent that label to a uuid column, the database refused the read, and the catch kept no trace. So no
manager's own visit and no place pin carried a position, and the live page said "visit positions
could not be read" on every load. Measured with and without the fix on that day's 64 waiting trips:
the lanes (23 Ready, 8,738.96 EGP; 41 Your call) and every check's answer were the same, because
the visits' own positions were enough that day. The read now asks by the bare uuid
(`managerOwnVisitUuid`), and both evidence reads record why they failed.

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
| Nine tabs and six tiles | Three lanes and six tiles, each counting one state. |
| On a phone the first claim began 904 px down, under the tiles (measured at 375, 23 Nov 2026) | On a phone the count, the lanes and the list come first; the tiles follow the list. A desktop is unchanged. |
| On a phone a Your call card ran up to 300 px: every other check that failed or could not be made was a tag on its own line (measured at 375 in the preview of pull request 700, 23 Nov 2026) | A phone card says them in one line ("Also failed: … · Not checked: …", `otherFindings` in `desk-view.ts`). The desktop row keeps a tag for each. |
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

### Export PDF — the reviewer on paper

His words, 23 Nov 2026: "to be able to export every PDF, every expense trip case as a PDF, looking
100% as it is looking in the system." So the PDF is not a second drawing of the case. The reviewer's
bar has an **Export PDF** button, on a waiting claim and on a decided one. The server opens the real
Expense Approvals page on that one trip and prints what the reviewer shows. "100% as it is in the
system" outranks the house document look for this one export.

**How it runs** (`src/lib/outstation/approvals/case-pdf.ts`, the route
`app/api/admin/outstation/approvals/[requestId]/pdf/route.ts`):

1. The route's gate is the one-trip read's own: signed in, the desk's read permission, a real
   session (a preview session is answered 409), and the claim on that person's list (404 before any
   browser opens). View as Seat never reaches the route: the export is on `SEAT_VIEW_REFUSED_READS`
   (`src/lib/auth/seat-view.ts`), because it signs a browser in as a real account and writes an
   audit row naming who took the file. `tests/seat-view.test.ts` refuses a GET that writes and is
   not on that list; the first push of this change was red on exactly that.
2. Chromium (the PDF printer's own, one of its two slots) signs in as the person who pressed, with a
   180-second session named "Phoenix expense case PDF export". It is revoked when the print ends,
   with reason `expense_case_pdf_export`. So the PDF shows what that person's own screen shows.
3. The page is opened on the deployment's own public address (`APP_URL`, else the production
   domain; a laptop uses its loopback port; `PHOENIX_CASE_PDF_ORIGIN` overrides). The map's key is
   tied to that address: on the loopback address Google answered `RefererNotAllowedMapError` and the
   map did not draw (measured 23 Nov 2026). The address is never taken from a request header.
4. Everything on the page but the reviewer is hidden, because the list behind it holds other people's
   claims and a PDF keeps text a screen only covers. The window is grown to the bar, the whole case
   and the foot, and the print waits until two readings agree and no photo or loader is still
   arriving (25 seconds at most; a late photo prints as the screen showed it).
5. One page, 1,440 px wide and as tall as the case, with the screen's own styles. A PDF page cannot
   be taller than 200 inches, so a case over 19,000 px is scaled down to fit one page, never split.

**The fence is an allow-list** (`classifyCasePdfRequest` in `case-pdf-plan.ts`), because the print
browser is signed in as a real person on the live database:

- GET and HEAD only, and no Server Action. The reviewer's buttons are never pressed.
- Of this app: the page, `/login` (so a refused sign-in is seen, not waited out), `/_next/`, static
  files, and the three reads an open case makes: the list, the one trip, and the visit workload.
  Every other address, another trip and the export itself included, is answered with nothing.
- Other sites over https (photos from storage, map tiles).
- One non-GET passes: the map's own viewport call to Google. It carries the map's bounds and
  nothing of Phoenix's.

A new read added to the reviewer must be added to `casePdfReads`, or that part prints empty.

**What it shares.** The opener is the ChatGPT connector's (`openSignedInPage`), which gained four
optional settings: the address, the fence, the session's name, and the non-GET prefixes its page
stub lets through. With none of them given the connector behaves as before, and the new export
address is on the list its captures refuse.

**What it does not replace.** The Expense Center page keeps its September "Download PDF", a
house-style summary of a claim with its own gate and its own list.

**What can only be proven on production.** The branch runs nowhere before the merge, so three things
were not seen in the built app: the map drawing in the server's Chromium on the public address, the
session cookie through the edge, and the time an export takes (budget 100 seconds, route limit 120).
A trial outside the app printed trip 341 at 1,440 × 2,137 px and it matched the screen.

**The button.** A press with a state, never a bare link: it reads "Preparing" while the server
prints, one export runs at a time, and the file is saved under the name the server gave it
(`Expense-trip-<name>-<days>-<number>.pdf`). While it prepares it is `aria-disabled`, not `disabled`,
so the keyboard stays inside the reviewer. The note under the bar remembers which claim it is about
(`caseExportNoteOnScreen`): he can walk to the next claim while a PDF is prepared, and the note then
says "the claim you exported", never "this claim". A failure stays until he closes it.

**What the access review changed** (23 Nov 2026, before the merge). It found nothing that lets the
print browser write, decide or widen access, and four things to tighten:

1. **The address is trusted, not only configured** (`trustedOriginOf`). The print browser carries a
   real person's session cookie to the address it opens, so a setting alone is never enough: it must
   be this box (loopback), or https on a host Phoenix is served from (production's, staging's). A
   mistyped or hostile `APP_URL` or override is ignored, and plain http never leaves the box. With no
   trusted address named, production opens its known domain and any other deployment stays on its
   own loopback port, so staging can never open production.
2. **A file printed before its pictures arrived says so.** The route answers
   `X-Phoenix-Case-Settled: no` when the 25 seconds ran out with a photo or a map still arriving;
   the button reads it and leaves an amber note under the bar (`CASE_PDF_LATE_NOTE`: the file was saved, a photo
   or a map had not finished loading, export it again if a picture is missing), so an empty box in a document about money is never taken for a
   missing photo. When time runs out the case is read once more: one that is no longer drawn (a
   loader, a failed read) is refused, never printed. The list is hidden a second time right before
   the print.
3. **One case prints at a time in a server process** (`createCasePdfTurn`), and the route carries the
   export limit its two spreadsheet siblings share (ten a minute a person). The printer has two
   Chromium slots for the whole app and a case can hold one for over a minute; two at once would
   leave an offer letter or a payslip waiting until it failed. The second export is answered 429 in
   words.
4. **The sign-in is checked live before a session is made.** A GET may otherwise stand on the
   ten-minute saved copy during a login-check outage; the route asks again with
   `allowRecentCopy: false`, as a password change does, so a copy never mints the print session.

Left as they were, with no live path found: a static-looking file name on a page address passes the
fence, and the memory a very tall case with many photos takes on the one production replica is not
measured.

Pinned by `tests/expense-case-pdf.test.ts`. Each of its assertions was proven by breaking the fix it
pins and watching that assertion fire: 46 cases on the first commit, 26 more on the review's fixes,
all fired.

### Filters and the Thursday flag

His words, 23 Nov 2026: "I want to be able to filter by, for example, meeting, for example, other,
for example, traveling. And I want you to flag any meeting that is not on Thursday." And a few
minutes later: "AND FILTER BY PERIOD OR MONTH OR DATE."

**The kind filter.** Under the lanes there are four buttons: All kinds, Traveling, Meeting, Other.
The kind is the claim's own expense type, the three values Submit Expense offers. Production held
332 Traveling, 24 Meeting and 7 Other claims that day, and nothing else. A type nobody recognises
reads as Traveling, so it is checked as a trip and never excused as a cost. On Ready and Your call
each button carries the number of claims of that kind in the lane. History is read from the server
50 at a time, so there the buttons carry no number.

**The trip-date filter.** Beside the kinds there are three controls:

- **Trip month** lists this month and the eleven before it. One pick narrows the list to that month.
- **From** picks one day. With no To chosen, the list shows that one day.
- **To** turns it into a period. Either end can be left open.

The date is the trip's own, the one each row prints. It is not the day the claim was filed or
decided. A trip of several days is listed when any of its days is inside the period, so a trip from
30 Oct to 2 Nov is listed under October and under November. From after To is read the other way
round. "Clear dates" removes the filter.

Both filters narrow Ready, Your call and History, and both are kept in the address (`kind`, `from`,
`to`), so a reload or a shared link opens the same list. On a waiting lane the page filters the
claims it already holds. On History the server filters, because the page holds only one page of it.
The trip days are stored as midnight UTC (all 363 claims on 23 Nov), so the server asks for trips
that ended on or after From and began before the day after To.

Read on production on 23 Nov through the app's own data API, with the filter strings the page
sends, and compared with the database read directly. Every count matched:

| Filter | Claims |
| --- | --- |
| Traveling | 332 |
| Meeting | 24 |
| Other | 7 |
| A trip day in November 2026 | 77 |
| A trip day in October 2026 | 116 |
| A trip day on 12 Nov 2026 | 3 |
| Traveling, with a trip day in November 2026 | 73 |

**The Thursday flag.** Meetings are held on a Thursday. `approvals/meeting-day.ts` adds one check,
"Meeting day", to a claim that claims a meeting:

- a claim filed as Meeting, and
- a Traveling or Other claim that carries a meeting amount. The amount is the one payroll reads, so
  a meeting amount already set to zero on review claims no meeting.

A claimed meeting on any other day fails the check, with the day in words: "The meeting was on
Monday 2 Nov, not a Thursday." A claim of several days does not say which day the meeting was held,
so it passes when one of its days is a Thursday and fails when none is. A claim with no readable day
is "could not check", which is never a pass.

The flag is a flag. A failed check files the claim in Your call and never rejects it, changes its
amount or stops it being filed. The reviewer shows the line with the other checks, and "Not a
Thursday" is offered as a one-press reason for a rejection or a reduced amount.

What it changes, read on production on 23 Nov:

- A Meeting or Other claim was never Ready, because its amount is the employee's and the invoice
  has to be read. For those the flag changes the reason the row wears. One Meeting claim waited, on
  Thursday 12 Nov, and it passes.
- A Traveling claim with a meeting amount could be Ready. Five such claims waited, none on a
  Thursday, with meeting amounts of EGP 70 to EGP 150. They are now in Your call.
- Among the 23 Meeting claims already decided, none of the 8 he rejected was on a Thursday, and 6 of
  the 15 he approved were.

The rules live in `approvals/claim-kind.ts`, `approvals/trip-period.ts` and
`approvals/meeting-day.ts`. The screen parts are `desk-kind-filter.tsx` and
`desk-period-filter.tsx`. Pinned by `tests/expense-desk-kind.test.ts`; eight of its assertions were
proven by breaking the fix each pins and watching the test fail.

Not seen in a browser before the merge: the dev server shows the live version, never a branch.

### What only time can prove

Three items of the audit cannot be scored on the day the page ships:

- that he approves at least 95% of what the page calls Ready;
- that the reasons on "Your call" match what he finds;
- that the median wait at decision falls under 3 days.

The page carries its own meter for the first. All three are read again 30 days after the merge.

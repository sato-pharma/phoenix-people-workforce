# Money integrity close-out — phase 2, money paths (19 Nov 2026)

The account behind REC-038 (close-out), REC-060 (money slice) and REC-078 (money half), and the three payroll
findings F-PAY-014, F-PAY-016 and F-PAY-017. Module rules point here: `.claude/rules/payroll-automated.md`,
`.claude/rules/payroll-files.md`, `.claude/rules/payroll.md`, `.claude/rules/engineering-tests.md`.

## 1. The two tests every money operation now has

For each operation shipped as "all or nothing, a second caller gets 409" (#312, #315, #333, #337, #341, #343):

- **(a) a forced failure after the first write finds nothing changed** — the test makes a write fail partway (inside
  the one database function, or the first follow-up the app makes), then deep-compares every table with its state
  before, checks the app wrote nothing after the failure, and checks the caller was refused, not told "saved".
- **(b) two callers, one winner** — two calls of the same operation on the same record start together against one
  shared state; exactly one lands, the other gets the refusal the code promises, and the end state shows the
  operation applied once.

Both run the REAL domain function against `tests/support/postgrest-transaction-stand-in.ts`, an in-memory PostgREST. A
database function is modelled from its migration, statement by statement, inside `atomically(...)`, which keeps
nothing when the model raises — exactly as Postgres does.

| Operation | (a) forced failure | (b) two callers | File |
| --- | --- | --- | --- |
| Held-salary record at publish (#312) | added | added | `payroll-ledger-and-permission-behaviour.test.ts` (`runHeldRecordAtomicityBehaviourTests`) |
| Direct-order collection (#333) | added — **its records inside the call since 19 Nov, see §2b** | added | `direct-orders-marketing-rollback-and-race.test.ts` |
| Marketing decision and cancel (#333) | added — **the cancel's record inside the call since 19 Nov, see §2b** | added | `direct-orders-marketing-rollback-and-race.test.ts` |
| Candidate merge (#333) | see the merge file | see the merge file | `candidate-merge-rollback-and-race.test.ts` |
| Retention conversations (#333) | added | added (update; a second create is a second conversation by design) | `hr-decisions-rollback-and-race.test.ts` |
| Leave decisions (#333) | added (step and paid approval) | added (manager twice; two Super Admins, balance used once) | `hr-decisions-rollback-and-race.test.ts` |
| Deduction decisions (#333) | added (stale revision, lock trigger on all three write paths) | added, a real race | `deductions-money-paths-behaviour.test.ts` |
| Deduction disputes (#333) | already covered | already covered | `dispute-and-deduction-atomic.test.ts` |
| Outstation claim approval and its second approve (#315) | added — **one database call since 19 Nov, see §2a** | added | `outstation-reapprove-rollback-and-race.test.ts` |
| Cancel, Reopen Part 2, Reopen Part 1 (#341, #343) | added — **cancel and Reopen Part 2 FIXED, see §2** | added | `payroll-run-money-paths-behaviour.test.ts` |
| Late-approved expense carry (#337) | added | added | `late-expenses-rollback-and-race.test.ts` |

## 2. Cancel and Reopen Part 2 are one database call each (REC-038)

Cancel made four or five separate writes: the override record (when finance had the files and a reason was given),
the late trips the run had set aside, the carry-forward release, the carry-forward discard, then the phase. A failure
after the first left a `ready` run with its trips back on the list, or its ledger half undone, or an override recorded
for a cancel that never happened. Reopen Part 2 had the same shape.

Both now call one function each, in migration `20261119120941_automated_payroll_cancel_and_reopen_part2_atomically.sql`:
`phx_cancel_automated_payroll_run` and `phx_reopen_automated_payroll_part2`. Each moves the phase under the move's
claim (refusing with `automated_payroll_transition_claim_lost` before anything when the claim is no longer its own),
records the override, releases the trips, releases and discards the ledger, and writes the move's audit row — in one
transaction. The bank-file check (`planUndoAfterDownloads`) still runs first, under the claim, and writes nothing; it
hands the override detail to the function. The same rows are written in the same order: no amount moves.

**The migration must be applied before this code is merged.** Until it is, Cancel run and Reopen Part 2 refuse and
change nothing ("could not be cancelled, so nothing was changed").

Reopen Part 1 was made one call on 14 Nov 2026 (`20261114170804`). Two writes still come before its call: the release
of reserved late trips (empty in the normal state — a run in Part 2 holds none) and the override record when a reason
is given. Neither moves money; folding them into the function needs a new function signature and was left for its own
change.

## 2a. Approving an outstation claim is one database call (REC-038)

Owner, 19 Nov 2026: "fix the outstation approval so it is one step". `approveOutstationRequestForPayroll` made three
separate calls: the claim's status update (pinned to the reviewer's revision), the push into payroll (a report row, then
the trip's `outstation_expenses` row), then the required records. A failed push left the claim reading accepted with an
empty report row; a failed record left the money queued while the approver was told the approval had failed.

It now makes ONE call, `phx_accept_outstation_claim_for_payroll` (migration
`20261119132423_outstation_accept_claim_for_payroll_atomically.sql`). Before it, nothing is written:
`planPayrollExpenseSave` (`src/lib/outstation/expenses.ts`) runs the payroll save's own code — every read, refusal and
figure — and stops before its first write, handing back the report values and the rows. The function then, in one
transaction: updates the claim only while it still carries the `updated_at` the reviewer saw (else it raises
`outstation_claim_changed`, the 409 the screens already show); updates the trip's report row, or inserts one; upserts the
trip's row on `trip_id` exactly as planned; and inserts both audit rows. After it commits, `finishPayrollExpenseSave`
pushes the moved decision into any open payroll run (it never throws and has its own retry queue). The same rows are
written with the same figures: no amount, rate or formula moves. A claim the evidence gate holds is accepted by the same
call with no payroll row and its "HELD out of payroll" record.

**The migration must be applied before this code is merged.** Until it is, approving a claim refuses and changes
nothing ("The claim could not be approved, so nothing was changed").

**The release is the same one call** (owner, 19 Nov 2026: "move the release path onto the one-call approval too";
migration `20261119143529_outstation_release_claim_to_payroll_atomically.sql`). `releaseOutstationRequestToPayrollIfReady`
delivers a held claim's payroll row once its missing photo or workload lands. It made separate calls (the report row, the
trip's row, then two records), so a failure part-way left an empty report row, or the money queued with no record saying
so. It now calls the same function with no status: the claim is left exactly as it is (no column and no `updated_at`
moves), locked, pinned to the version the release read, and required to still read accepted — so a claim rejected in
between is never pushed, even by a writer that forgot to move the version. The report, the trip's row and both records
("expense pushed to payroll", "released into payroll — evidence complete") land together or not at all; a failure leaves
the claim held and the next capture tries again. The redefinition also reuses the trip's own report when no report id is
passed, read under the claim's lock, so two releases landing together leave one report row rather than an empty second
one. The system's automatic acceptance already ran through `approveOutstationRequestForPayroll`, so with the release moved
the old push (`pushAcceptedOutstationExpenseToPayroll`) had no caller and is gone; the approval and the release share
`planAcceptedClaimPayrollRow` and `writeClaimToPayrollInOneStep` in `src/lib/outstation/service.ts`.

**Migration `20261119143529` must be applied before that code is merged.** Until it is, a release refuses and changes
nothing; the claim stays held. The live approval never passes a null status, so applying it first changes nothing it does.

`tests/outstation-reapprove-rollback-and-race.test.ts` models the function statement by statement from its migration and
runs the real approval against it: a payroll row or a record failing inside the call (every table equals before, the app
writes nothing outside the call, the refusal says nothing changed, and approving again from the same screen pays once);
two approvals at once (one applies, the other gets "the claim changed", one row, one report, one record each); a change
landing after the version check (refused, never approved unseen); the unchanged re-approve (no call at all); a held
claim (accepted with no payroll row); and the release — a failure inside its call (every table as before, the claim left
held, the next release pays once and leaves the claim untouched), two releases at once (one payroll row, one report row),
a claim rejected after the release read it, with and without a moved version (never pushed), and a claim re-priced
between the release's read and its pin (refused, then released at the new figure). Its breaks are in §7.

## 2b. The direct-order collection and the marketing cancel write their records inside their one call (REC-038)

Owner, 19 Nov 2026: "fix the direct-order collection and marketing cancel the same way". Both were already one database
function each (#333): `phx_record_direct_order_collection` and `phx_cancel_marketing_request`. But each committed first,
and the app wrote the record afterwards — the collection's required audit row, then the order's event row, then the sheet
ping; the cancel's required audit row. A record that failed left the collection (or the cancel) standing while the person
was told the save had failed, and the collection's event row and sheet ping were skipped.

Migration `20261119145916_direct_order_collection_and_marketing_cancel_write_records.sql` gives each function a form that
takes the records' words from the app and writes the rows itself, in the same transaction, after the act:

- **the collection** (7 arguments): the lock, the compare-and-set, the offsets under the lock, the money checks and the
  one update, line for line as before; then the audit row (old and new paid amount, date and remainder) and the order's
  event (the remainder the function computed fills the "still outstanding" sentence's `{remaining}`);
- **the cancel** (5 arguments): the lock, the compare-and-set, the flip and the rungs closed as before; then the audit
  row naming the status it replaced and the rungs it closed.

The rows carry the same words and values the app wrote before. The sheet ping stays after the commit. A collection that
committed is now answered as saved even when the read-back after it fails (it answers from the figures written).

**The earlier forms stayed** until this code was live, so the code serving before the merge kept working between the apply
and the deploy; neither form has a default, so PostgREST picked each by the arguments sent. #614 went live at 15:18 Cairo,
and `20261119153902_drop_superseded_collection_and_cancel_forms.sql` (owner: "drop the old collection and cancel function
forms") drops both earlier forms: nothing called them, and left in place they were a way to collect or cancel without
writing the record. `tests/direct-orders-and-marketing-atomic.test.ts` §10 pins the drop and refuses a later migration
that brings either back.

**Migration `20261119145916` must be applied before this code is merged.** Until it is, a collection and a cancel
refuse and change nothing.

`tests/direct-orders-marketing-rollback-and-race.test.ts` models both forms statement by statement: a record failing
inside the call keeps nothing (the act included), the records land with the act in the app's own words (a remainder
still owed, paid in full, cleared; a cancel's summary and values), a committed collection whose read-back fails is
answered as saved, and the two-caller races write one record each. `tests/direct-orders-and-marketing-atomic.test.ts`
pins that the new forms keep every lock, compare-and-set and money rule of the earlier ones, and that the app writes no
record of its own after either call.

## 3. F-PAY-014 — publish works out its figures under its claim

Publish assembled every row, ran its gates, built the held record and the bank coverage, and only then claimed the
run. A Reopen Part 2, a save and a re-confirm landing in those seconds left it publishing figures the run no longer
held. It now claims first (after the cheap phase check) and re-reads the run under the claim; a refusal lets the claim
go.

The claim lapses 15 minutes after it is taken, so that a request that died does not hold the run for ever. Publish
holds it while it writes real money, so before each money write — the salary batch, a leftover batch's rewrite, its
approval, the carry-forward settlement, the held-salary releases — it renews the claim with one statement conditioned
on its token (`renewRunTransition`). A live publish's claim therefore never lapses under it, and a claim another action
already took refuses the next write instead of letting it land. No database change: the renewal is a conditioned update.

## 4. F-PAY-016 and F-PAY-017

**F-PAY-016 was already fixed** (#315, #341, #343): every finance and bank file writes a required
`bank_file_downloaded` row before it is handed out, and cancel and both reopens refuse after one unless a reason of
10+ characters is given. What was missing was a test that drives `cancelRun` itself; it is in
`payroll-run-money-paths-behaviour.test.ts` §1, and the override is now recorded inside the cancel's one call.

**F-PAY-017 — a step save checks every figure it writes, not only the step.** A step's revision was its state row's
`updated_at`. But a Deductions or expense decision landing on a step nobody confirmed clears that step's figures and
writes no step state, so a screen opened earlier saved the old figure straight back. The draft rows had no version.

Every write to a draft-row figure already leaves a numbered line in `automated_payroll_draft_cell_history` (a trigger,
so nothing can skip it). The revision the screen and the step file carry now also names the highest line the run had
when the step was read — its cell watermark — as `<step updated_at | none>|cells:<n>`
(`src/lib/automated-payroll/step-revision.ts`). Under the run's hold, a save is refused with the stale-step words when a
figure it is about to write has a newer line, naming who changed. A figure of another person or another column never
refuses, so two people saving different steps never refuse each other. An older screen or file with no watermark is
judged on the step alone, as before. No database change.

## 5. Found and NOT fixed here

1. ~~**Approving an outstation claim is not all or nothing.**~~ **Fixed on 19 Nov 2026 — one database call, see §2a.**
2. ~~**`reserveLateExpenses` deletes a run's earlier reservations before it inserts the new ones.**~~ **Fixed on 19 Nov
   2026** (owner: "make the late-trip reservation one step"). The replace is now one database call,
   `phx_reserve_late_expenses` (migration `20261119163918_late_expense_reservations_replace_atomically.sql`): the delete
   and the insert run in one transaction, so a failed insert — including a trip another run took a moment ago (23505) —
   keeps the run's earlier reservations. The read that names another run's hold still runs first and writes nothing.
   `tests/late-expenses-rollback-and-race.test.ts` now gives the run an earlier reservation and checks it survives a
   failed call and a lost race; **the migration must be applied before that code is merged** (until it is, a Part 2
   confirm that carries a late trip refuses and changes nothing).
3. ~~**`setCarryLateExpenses` reopens open runs' Expenses steps before the switch moves.**~~ **Fixed on 19 Nov 2026**
   (owner: "fix setCarryLateExpenses so the switch moves before any step reopens"). The setting is saved and its
   required audit row written first; only then is each open run's Expenses figure cleared and its step reopened. A
   failed save reopens nothing and changes nothing; a failed audit row puts the old setting back and reopens nothing.
   Every open run is tried even after one refuses, and a run whose step could not be reopened is named in the
   refusal, which says the switch IS changed and recorded — its figures stay as they were until HR reopens that step,
   and Part 2 confirm still refuses a step confirmed under the other setting. The audit row now names the runs it is
   about to reopen (`expensesStepsToReopen`), because it is written before them. After a refused flip the panel
   re-reads where the switch stands. No database change. `tests/late-expenses-rollback-and-race.test.ts` gives every
   failure an open Part 1 run and checks it is not reopened, and checks the run after a refusal is still reopened.
4. ~~**A collection or a marketing cancel whose record fails after the database step committed reads as failed.**~~
   **Fixed on 19 Nov 2026 — each writes its records inside its one call, see §2b.**
5. ~~**The Payroll Copilot's Holiday Bridging tab looks broken today**~~ **Fixed on 19 Nov 2026** (owner: "fix the Payroll
   Copilot Holiday Bridging tab's Exclude and Include"). Its GET built each row by hand and left `requestId` out, so every
   Exclude and Include posted a blank request id and was refused 400. The row and the decision body are now built by one
   client-safe module, `src/lib/payroll/copilot/holiday-bridging-row.ts`, which the route and the tab both use;
   `tests/payroll-copilot-holiday-bridging-roundtrip.test.ts` posts a body built from a screen row through the real route
   and sees the exclusion recorded against the right request, and Include lift it.

## 6. REC-060 — every money route judges its body with a schema

`zod` was in `package.json` and no file under `app/` imported it. Every POST, PATCH, PUT and DELETE handler in the money
areas now reads its body ONLY through `parseJsonBody(request, schema, { fallback })` or `parseFormBody(request, schema)`
(`src/lib/http/request-body.ts`), right after its access check, and answers a refused body with its own error shape and
status. The areas: payroll and the Payroll Copilot, automated payroll, deductions and daily deductions, the dispute
routes (Dispute Center, daily-deduction disputes, attendance-digest disputes), outstation and expense claims, the salary
flags and the direct-order collection — 86 route files on 19 Nov 2026. Incentive payouts have no write route of their
own: an incentive reaches a payslip as an Additions figure in the Automated Payroll wizard.

Each schema accepts everything its screen sends today (read from the calling component; where unsure, a field is
optional or permissive), keeps the route's coercions, and drops nothing a service reads. A route whose permission rule
lived only in its service now asks that same gate (or `assertSignedIn`) before the body, so a stranger is refused
before the body is judged (#585). What changed for bodies no screen sends: unreadable JSON that used to fall through to
a 500 is now a 400, and a field of the wrong type gets a 400 naming the field.

`tests/money-route-body-schema.test.ts` lists every money route that reads a body any other way, and the list is held at
empty; a route that reads no body is pinned by name, so a new route reading its body through a helper fails until
someone looks. The REC-080 route guard harness ran over all 86 files: 190 calls, 0 problems.

## 7. Break tests

Every new test was broken in the APP code (or, where the rule lives only in SQL, in its model) and its own assertion
watched to fire, then restored green. The payroll-run suite's eleven breaks, for example:

| Break | Assertion that fired |
| --- | --- |
| cancel releases the trips before its one call | after a failure at write 1: the run is still ready, its trips still set aside… |
| cancel skips the bank-file check | HEADLINE (F-PAY-016): a cancel after a recorded bank-file download is refused… |
| a refused claim is taken as held anyway | with the words of a run another action took |
| publish reads figures before claiming | HEADLINE (F-PAY-014): and it read no figure before the claim refused it |
| a renewal ignores whose claim it is | HEADLINE: the old holder's renewal fails |
| no renewal before the salary batch | the claim is renewed right before createSalaryBatch |
| the figure check ignores the column | another column of the same person refused the save |
| saveStep skips the figure check | HEADLINE (F-PAY-017): saveStep checks the figures under the hold, before it writes |
| the step read takes the watermark after the figures | the watermark is read BEFORE the figures the screen will show |
| Reopen Part 1 skips the bank-file check | a Part 1 download refuses Reopen Part 1 without a reason |
| Reopen Part 2 releases its trips outside the call | after a failure at write 1: still ready, trips still reserved, ledger untouched |

The outstation approval's breaks (§2a), each watched to fire and restored green:

| Break | Assertion that fired |
| --- | --- |
| the claim's status is written before the call (the old shape) | HEADLINE: the app wrote nothing outside the one call |
| the plan writes the report row | HEADLINE: the app wrote nothing outside the one call |
| the records are left out of the call | the call carried both records |
| the gate is ignored, so a held claim is planned into payroll | held: HEADLINE: the call carries no payroll row and no report |
| a moved claim is not reported as changed | the losing approval is refused as "the claim changed" |
| the call carries a version read again just before it | the call carried the version that was CHECKED |
| model: the claim's update ignores `updated_at` | HEADLINE: exactly one of two simultaneous approvals applies |
| model: a raise keeps what ran | HEADLINE: every table afterwards equals the tables before |
| the version check is skipped | (in `outstation-stale-approval.test.ts`) approve must check the version and then write |
| the release writes its records outside the call | (c) release: and both records |
| the release updates the claim (passes a status) | (c) release: as a release — no status, so the claim is not updated |
| the release skips comparing the version it pins with the claim it read | (c) re-priced: HEADLINE: the release refuses rather than push figures the claim no longer holds |
| the release reports a moved claim as released | (c) rejected under the release: HEADLINE: never released |
| model: the release does not require the claim to read accepted | (c) rejected by a writer that forgot the version: HEADLINE: never released |
| model: no report lookup under the lock | (c) and one report row |

The collection's and the cancel's breaks (§2b), each watched to fire and restored green:

| Break | Assertion that fired |
| --- | --- |
| the collection's audit row written by the app after the call | ONE audit row |
| a read-back failure after a committed collection refuses again | READ-BACK: HEADLINE: Finance is never refused for a collection that committed |
| the "still outstanding" sentence loses its `{remaining}` placeholder | RECORDS (outstanding): one event on the order's timeline, in the words the app used to write |
| model: the collection's records written outside the transaction | ONE audit row |
| the cancel's audit row written by the app after the call | the cancel and its audit row were written by the one call |
| model: the cancel's audit row written outside the transaction | ONE cancel audit row |

The late-trip reservation's breaks (§5 item 2), each watched to fire and restored green:

| Break | Assertion that fired |
| --- | --- |
| the release goes back before the one call | RACE: no release or insert of its own outside the one call |
| model: the function keeps its delete when its insert fails | RESERVE LOSES A RACE: HEADLINE: the stored reservations are exactly as they were |
| a lost race is not named as another run's hold | RACE: the loser is told with a LateExpenseRefusal |

The switch's breaks (§5 item 3), each watched to fire and restored green:

| Break | Assertion that fired |
| --- | --- |
| every open run reopened before the switch is saved (the old order) | SWITCH SAVE FAILS: HEADLINE: the open Part 1 run's Expenses step is NOT reopened; and in the main suite, HEADLINE: the switch moves first |
| stop at the first run that refuses | REOPEN FAILS: HEADLINE: each step is reopened only after the switch was saved and recorded — and the run after the one that refused is still tried |
| a refused reopen answered as changed | REOPEN FAILS: the caller is told something was left undone |
| the panel no longer re-reads the switch after a refused flip | a failed flip re-reads the switch and reloads the step, then shows the refusal |

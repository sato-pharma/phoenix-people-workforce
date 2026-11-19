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
| Direct-order collection (#333) | see the orders file | see the orders file | `direct-orders-marketing-rollback-and-race.test.ts` |
| Marketing decision and cancel (#333) | see the orders file | see the orders file | `direct-orders-marketing-rollback-and-race.test.ts` |
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

The other two pushes — the release of a held claim once its evidence lands, and the system's own acceptance — still use
`pushAcceptedOutstationExpenseToPayroll`; neither moves a claim the reviewer is looking at.

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
2. **`reserveLateExpenses` deletes a run's earlier reservations before it inserts the new ones.** If the insert fails,
   the earlier rows stay gone. A run reaching Part 2 confirm normally holds none, and an unconfirmed run pays no carried
   trip, so the risk is low. The switch starts OFF and stays the owner's.
3. **`setCarryLateExpenses` reopens open runs' Expenses steps before the switch moves.** When its audit row then fails,
   the switch is put back but the reopened steps stay reopened. No money moves; HR re-confirms the step.
4. **A collection or a marketing cancel whose record fails after the database step committed reads as failed.** The
   collection (or the cancel) stands, the record is queued in the outbox and not lost, but the person is told the save
   failed and the order's event row and sheet ping are skipped. A retry from the same screen is refused by the
   compare-and-set, so no money is doubled. The fix is to write the record inside the function, or to answer "saved"
   once the database step committed and the record is queued. The outstation approval had the same shape until it wrote
   its records inside its one call (§2a).
5. **The Payroll Copilot's Holiday Bridging tab looks broken today**: its GET leaves `requestId` out of each row, so its
   Exclude / Include post answers 400. The schema keeps `requestId` optional, so nothing about that answer changed.

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

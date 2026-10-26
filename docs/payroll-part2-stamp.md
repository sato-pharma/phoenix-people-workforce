# The Part 2 stamp — what publish and the Part 2 files are held to

Technical audit, 2026-10-23 (PR #6289). The rule line in `.claude/rules/payroll.md` is the cue; this is the account.

## The rule

🔴 **EVERY FILE THAT PAYS PART 2, AND PUBLISH, MUST MATCH THE PART 2 STAMP — AND A MISSING STAMP REFUSES, IT NEVER PASSES** (technical audit, 2026-10-23). `assertMatchesPart2Confirm` (`publish-guard.ts`) is the one check: publish, the full finance sheet and the Part 2 FAB and CIB files all run it on the rows they are about to write — the files only while the run is `ready`, so a published month's re-download is never refused by a later salary edit, and publish skips it only for a run confirmed before the stamp existed (`PART2_STAMP_FIRST_WRITTEN_AT`, 11 Sep 2026), recording `totalsComparedToConfirm: false`. The stamp is a REQUIRED audit row (`part2_totals_stamped`), written inside Part 2 confirm's claim before the carry-forward ledger and the phase write, and the confirm re-assembles under that claim and refuses if anything moved. A run with no stamp is fixed by reopening and re-confirming Part 2, never by letting it through. Publish finalises its own leftover batch only after `compareSalaryBatchRecords` proves every record, every column and nobody extra; it rewrites a still-replaceable batch and refuses an approved or locked one only when pay, payment mode or the people differ (`SALARY_RECORD_MONEY_COLUMNS`) — a renamed title is recorded, not refused. Step saves, step confirms, exclusions and both resyncs write under the run's hold (`run-hold.ts`); a resync whose 5-second wait runs out is refused like any other write and parked in `automated_payroll_resync_outbox`, which retries it under the hold (audit 2026-10-26, P2-02) — never unheld. Pinned by `tests/automated-payroll-money-integrity.test.ts`.

## The conditions the risk review added

- **The files are held to the stamp only while the run is `ready`.** That is the window finance executes them in. A published
  month's re-download is never refused because somebody edited a salary afterwards.
- **Runs confirmed before the stamp existed** (before `PART2_STAMP_FIRST_WRITTEN_AT`, 2026-09-11 17:18:30 UTC, #3706) are
  not refused at publish for having no stamp. The audit row records `totalsComparedToConfirm: false` for them.
- **The stamp is written before the carry-forward ledger.** If the stamp cannot be written, no overpayment is left recorded as
  a debt for another run to collect.
- **A live (approved or locked) batch is compared on pay only.** Pay means `SALARY_RECORD_MONEY_COLUMNS` (every amount, plus
  payment mode) and who is paid. A difference in a descriptive field, such as a job title renamed between two attempts, is
  recorded in `batchNotes.liveBatchDescriptiveDifferences` and is not refused.
- **A resync whose wait runs out is queued, never run unheld** (audit 2026-10-26, P2-02). Both resyncs wait 5 seconds for the
  run's hold. Until 26 Oct an expired wait went ahead WITHOUT the hold (`whenWaitRunsOut: "proceed"`), so a clear could land
  inside a Part confirm. Now the wait refuses, and the refused resync is parked with its whole target in
  `automated_payroll_resync_outbox` (`resync-outbox.ts`, the shared `write-outbox.ts` mechanism) and retried under the hold —
  drained off the run page and off every resync that succeeds, no cron. The save says the decision is queued. A retry
  re-checks everything.
- 🔴 **No parked decision is left behind** (risk review, 26 Oct). A retry that finds Part 2 already confirmed KEEPS its row —
  it used to count as landed, so the row was deleted and the decision vanished while the run paid the old figure. Confirming
  Part 2 lands the month's parked rows first, back-off ignored (`landQueuedPayrollResyncsForPeriod`), then refuses under its
  claim while any remain or the queue cannot be read (`describeParkedResyncRefusal`, a 409). Reopening Part 2 lands what was
  waiting for it, and the run page lists every parked decision (`RunView.parkedResyncs`, null when unreadable). A row whose
  month has no open run any more is dropped with an `automated_payroll_queued_resync_no_open_run` log.
- **A claim is retried when its holder has let go.** `claimTransition` also retries when the holder released the run
  (`transitionInProgress`).

## Where the money goes is stamped too (owner, 2026-10-23)

The totals catch every change to an amount, not to a destination. A bank or account number edited on the
employee record after Part 2 confirm moved no total, and the FAB and CIB files read both straight from the
live row. The owner was asked and answered **"Block it"**.

- Part 2 confirm now also stamps `confirmedBankDetails`: per person (compact HR id), a SHA-256 fingerprint of
  the run id, the person, the bank name (trimmed, upper-cased) and the account (trimmed), the same reading the
  files make. **No account number is stored** — the audit trail is kept for ever.
- It rides on BOTH stamp rows (`part2_totals_stamped` and `part2_confirmed`). `readPart2ConfirmedStamp` takes the
  newest of the two, and `part2_confirmed` is written last, so leaving it off that row would switch the check off.
- The confirm compares the fingerprints again under its claim, like the totals.
- The full finance sheet and the Part 2 FAB and CIB files refuse when anyone's fingerprint moved, or anyone was
  added or dropped, naming who (`assertBankDetailsMatchPart2Confirm`). Same window as the totals: only while the
  run is `ready`.
- **A stamp written before 2026-10-23 carries no fingerprints and is held to its totals alone** — refusing it
  would block a month for a check that did not exist when it was confirmed. Read on production the day this
  shipped: no run was `ready` (October 2026 was in Part 1), so no live month was affected either way.
- Publish is not held to the fingerprints: payslips record what was paid, and the files are what pay.

## A refused download reads as a page (owner, 2026-10-23)

The finance downloads are started by sending the browser to the route, so a refusal used to land finance on raw
`{"success":false,"error":…}` text. `downloadError` (`src/lib/automated-payroll/http.ts`) answers a request that
accepts `text/html` with a plain page carrying the same message and a link back to the finance downloads;
anything else still gets the JSON. The three finance routes (`finance/download`, `fab-download`, `cib-download`)
use it for every refusal.

## What the review left open

- Step confirm computes its rows before taking the hold. This was already the case before #6289.
- The stamp compares totals and each person's bank destination, not every per-person amount.
- Part 2 non-employee entries take no hold.
- Production read 2026-10-23: no `ready` run lacked a stamp (none was `ready`).

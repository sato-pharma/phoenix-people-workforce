# The Part 2 stamp — what publish and the Part 2 files are held to

Technical audit, 2026-10-23 (PR #6289). The rule line in `.claude/rules/payroll.md` is the cue; this is the account.

## The rule

🔴 **EVERY FILE THAT PAYS PART 2, AND PUBLISH, MUST MATCH THE PART 2 STAMP — AND A MISSING STAMP REFUSES, IT NEVER PASSES** (technical audit, 2026-10-23). `assertMatchesPart2Confirm` (`publish-guard.ts`) is the one check: publish, the full finance sheet and the Part 2 FAB and CIB files all run it on the rows they are about to write — the files only while the run is `ready`, so a published month's re-download is never refused by a later salary edit, and publish skips it only for a run confirmed before the stamp existed (`PART2_STAMP_FIRST_WRITTEN_AT`, 11 Sep 2026), recording `totalsComparedToConfirm: false`. The stamp is a REQUIRED audit row (`part2_totals_stamped`), written inside Part 2 confirm's claim before the carry-forward ledger and the phase write, and the confirm re-assembles under that claim and refuses if anything moved. A run with no stamp is fixed by reopening and re-confirming Part 2, never by letting it through. Publish finalises its own leftover batch only after `compareSalaryBatchRecords` proves every record, every column and nobody extra; it rewrites a still-replaceable batch and refuses an approved or locked one only when pay, payment mode or the people differ (`SALARY_RECORD_MONEY_COLUMNS`) — a renamed title is recorded, not refused. Step saves, step confirms, exclusions and both resyncs write under the run's hold (`run-hold.ts`); a resync whose 5-second wait runs out while the run is still in Part 1 or Part 2 goes ahead unheld (`whenWaitRunsOut: "proceed"`) rather than leave the old figure in payroll. Pinned by `tests/automated-payroll-money-integrity.test.ts`.

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
- **A resync proceeds after its wait runs out.** Both resyncs wait 5 seconds for the run's hold. When the wait expires and the
  run is still in Part 1 or Part 2, the resync goes ahead unheld (`whenWaitRunsOut: "proceed"`) and logs
  `automated_payroll_run_hold_wait_expired`. Failing instead would leave the old figure in payroll. A run that has moved past
  those phases is still refused.
- **A claim is retried when its holder has let go.** `claimTransition` also retries when the holder released the run
  (`transitionInProgress`).

## What the review left open

- Step confirm computes its rows before taking the hold. This was already the case before #6289.
- The stamp compares totals, not row by row.
- Part 2 non-employee entries take no hold.
- Production was not read to check whether any `ready` run lacks a stamp.

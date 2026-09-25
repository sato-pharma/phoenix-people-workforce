---
name: automated-payroll-carry-forward-and-accuracy-nets
description: "2026-07-25: closed all four Automated Payroll audit accuracy gaps. Owner decision = CARRY FORWARD overpaid money (new automated_payroll_carry_forward ledger). reconcile() now ENFORCES at Part 2 confirm (split mismatch hard-blocks, overpaid needs acknowledgment). assembleRows/reconcile finally tested. Population-diff guard names silent disappearances. PR #1335."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-31T16:24:12.333Z
---

Closes every finding of the 2026-07-25 `src/lib/automated-payroll/` accounting
audit. That audit had its own memory (`automated-payroll-accounting-gaps`);
it was folded into this file and deleted 2026-07-31, because its headline
status was "none fixed yet" and everything below contradicts it.

**1. Overpaid carry-forward — owner decision was CARRY FORWARD, not write off.**
New `automated_payroll_carry_forward` table (migration
`20260725160000`), service `src/lib/automated-payroll/carry-forward.ts`.
Lifecycle: run N's Part 2 confirm records each `overpaidResidual` → a LATER run
applies it as a deduction via `assembleRows`'s new `carryForwardByCompact` input
→ that run's confirm marks it applied. Chose a LEDGER over a running-balance
column so the money has a trail (which run created it, which recovered it).
Guards built in: unique `(source_run_id, employee_hr_id_compact)` makes
re-confirming Part 2 idempotent instead of stacking duplicate debts; a
`amount > 0` check constraint means the ledger can never hold a negative that
would silently PAY an employee; `assembleRows` also clamps at 0 defensively;
`outstandingCarryForwardFor` filters `source_run_id <> currentRunId` so a run
can never consume its own fresh residual. Order at confirm matters and is
commented in run-service: mark-recovered FIRST, then record-new. Surfaced as its
own "Recovered (prev. overpay)" column + a cover-sheet line, deliberately not
buried in otherDeductions.

**2. The accuracy nets now ENFORCE.** `confirmPart2` runs `reconcile()`
unconditionally (it used to run only `preflightValidate`). `splitMismatches`
HARD-BLOCKS with no override — reconcile's own comment says it can only mean a
calculation bug. `overpaid` requires acknowledgment: the service embeds a stable
marker `OVERPAID_ACK_REQUIRED = "[overpaid-acknowledgment-required]"`, the route
detects it and returns `{requiresOverpaidAcknowledgment: true}` + 409, and the
wizard shows an amber accept/cancel banner. **Do NOT string-match the sentence** —
the marker is the contract, and a test pins its exact value because renaming it
would silently downgrade the gate into an unpassable red error. The acknowledgment
(count + total) is written to the audit log, not just "someone clicked twice".

**3. assembleRows + reconcile finally have tests** (`tests/automated-payroll-assemble.test.ts`).
The headline is DEDUCTION-COUNTED-ONCE: every deduction column set to a distinct
non-zero value, then the exact total asserted — verified it fails on a simulated
double-count (1950 !== 1050). That is precisely the bug class that once passed
all 428 test files undetected. Fixtures cast a minimal object to
`EmployeeDirectoryRow` rather than restating ~60 unrelated columns.

**4. Population-diff guard** (`src/lib/automated-payroll/population-diff.ts` +
`/api/automated-payroll/runs/:runId/population-diff`, loaded EAGERLY on run load,
not behind a button — the bug it guards is invisible by definition). Splits
absences into `left` (had a resignation on file, expected) vs `disappeared`
(no explanation — the bug bucket, should always be empty). Baseline is last
month's PUBLISHED salary_records, not a re-derived population, so the very bug
it detects can't skew the comparison. Test pins the case a bare headcount check
CANNOT catch: a joiner masking a disappearance in the same month (2 → 2).

**5. Export-order drift is deterministic + visible now.** Owner's
`FIXED_EXPORT_HR_ID_ORDER` stays authoritative; anyone unlisted is now sorted by
line → hire date → HR_ID instead of arbitrary arrival order, and
`unlistedExportHrIds()` puts a "Not in fixed export order — N employee(s)
appended" line on the cover sheet. **Live production run reports 5 right now.**
The list itself is still hand-maintained (123 IDs vs 132 active employees) — the
durable fix (derive from data or an HR-editable table) is still open, this just
stops it degrading silently.

**Status: MERGED + PRODUCTION-LIVE 2026-07-25.** PR #1335 merged 19:37 Cairo by
the owner (`Phoenix-HR` account) — not by this session. Cloud Run revision
`phoenix-hr-00509-xen` promoted to 100% traffic 19:53 Cairo after the standard
no-traffic + smoke-test gate. Verified live: `phoenix-hr.satopharma.com` 200,
`/api/automated-payroll/runs` returns a clean 403 (auth gate working, NOT a 500
— the signal that the new carry-forward/non-employees code paths are healthy),
zero rows in `app_error_events` since deploy, and the July run untouched at 117
draft rows / phase `part1`.

**PRODUCTION MIGRATIONS APPLIED 2026-07-25** (owner: "Proceed production
migration") to `ozucdzovmcqvepbozvqf`. All four went in add-only, in timestamp
order: `resignation_crm_days`, the 5 `special_*` columns,
`automated_payroll_non_employees`, `automated_payroll_carry_forward`.
Pre/post integrity verified identical — 117 draft rows, 1 run (July, phase
`part1`), new columns all NULL (no backfill), no advisories on the new tables,
0 ERROR-level advisories overall, both new tables RLS-enabled with 4 policies
and zero anon grants. Live post-migration smoke: non-employees / special
situations / population-diff / reconcile endpoints and BOTH sheet downloads all
200, Part 1 sheet unchanged at 118 employees / EGP 1,756,785.77.

Note the code still carries `isMissingTableError` tolerance in
`carry-forward.ts` and `non-employees.ts` — now redundant on prod/staging, but
keep it: it is what let the code ship BEFORE the migration without 500-ing the
existing sheet downloads, and it protects any future environment (a fresh
branch DB, a restored backup) that hasn't caught up yet.

**FOLLOW-UP PR #1344 — MERGED + PROD-LIVE 2026-07-25** (merged 20:30 Cairo by
the owner; Cloud Run revision `phoenix-hr-00512-big` at 20:43 Cairo; verified
domain 200, API 403 not 500, zero `app_error_events`, July run untouched at 117
rows / phase `part1`). No migration — schema unchanged. Two gaps found by
re-auditing the above the same day:

1. **Money-losing bug the ledger itself introduced.** Cancelling a run AFTER
   Part 2 confirm silently forgave real money: `confirmPart2` marks previous
   months' overpayments as recovered by that run, but a `ready` run is still
   cancellable (`assertActiveRun` only blocks published/cancelled) and a
   cancelled run pays nobody. Fixed with
   `releaseCarryForwardForCancelledRun(runId)` called from `cancelRun` BEFORE
   the phase flips: consumed balances go back to outstanding, unapplied ones the
   run created are discarded, balances a LATER run already recovered are left
   alone. **Lesson: when adding a state-mutating step to a lifecycle, check
   every other transition out of that state — confirm was covered, cancel wasn't.**
2. Full monthly sheet + both finance scopes now include Non-Employees Payroll
   (owner decision: their money leaves the company this month, so finance's
   complete picture must show it). `appendNonEmployeesSection` took an
   `employeeTotalLabel` so the grand-total row names First Part vs Month Salary
   correctly instead of hardcoding one.

**Weak-test lesson worth keeping:** the first cancel guard asserted on the bare
function name and PASSED with the real call deleted — because it also matched
the explanatory comment inside `cancelRun`. Source-scanning tests must strip
comments and assert on the call expression (`await fn(`), not the identifier.
Caught only because prove-it-fails was actually run.

Still open from the original audit: no maker/checker separation (HR_ROLES and
PUBLISHER_ROLES are both `["Super Admin"]`) — flagged to the owner, awaiting an
explicit decision. Also still hand-maintained: `FIXED_EXPORT_HR_ID_ORDER`.

**Why the audit happened at all, kept from the now-deleted
`automated-payroll-accounting-gaps` memory (2026-07-25, all four of its findings
closed above):** the riskiest files in `src/lib/automated-payroll/` had ZERO
coverage — `recommend.ts` (~1240 lines), `assemble.ts`, `run-service.ts`,
`reconcile.ts` — while three test files covered only pure money math,
fingerprint aggregation and export order. **A green suite proved nothing here:**
a 4-tab refactor plus a new eligibility rule passed all 428 test files while
carrying a live double-deduction bug. The structural insight was that
`overpaidResidual` hit **one-part employees hardest** (no Second Part to net
against), which is why the owner's request to move CRM/Vacation into Part 1 for
them was a real accounting fix, not cosmetics. Highest-value test remains one
asserting each deduction lands exactly once in `totalDeductions`.

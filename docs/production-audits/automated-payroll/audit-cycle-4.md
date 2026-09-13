# Automated Payroll — Audit Cycle 4

**Opened:** 2026-09-12 · **Findings covered:** 1, 6–13, 19, 21, 24, 25, 28 (the fourteen)
**Status:** ALL FOURTEEN ACCOUNTED FOR — every one fixed, each by a named merged PR
**Cycle 1:** [audit-ledger.md](audit-ledger.md) · **Cycle 2:** [audit-cycle-2.md](audit-cycle-2.md) · **Cycle 3:** [audit-cycle-3.md](audit-cycle-3.md)
**The audit itself:** [audit-original-findings.md](audit-original-findings.md) — recovered by this cycle

> **This cycle overturns the central claim of cycles 1 and 2.** They recorded fourteen findings as
> having no trace anywhere and, on that basis, the owner ruled them permanently unrecoverable. Both
> halves of that are now wrong: **the audit was recoverable, and every one of the fourteen was
> already fixed.** The ruling is resolved rather than suspended, and it is left standing in the
> ledger rather than deleted, because a record that hides what it once concluded is worth less than
> one that shows it.

## What actually happened

The audit was never in the repository. That is true, and it was the whole basis of the ruling. But it
had never left the machine either. It was in the transcript of the Claude Code session that produced
it — `f010eb82-1a95-4f43-894a-e3d70a9149cd.jsonl`, 16.6 MB, last written 2026-09-11 20:52 Cairo —
under `~/.claude/projects/F--Phoenix-Workforce-phoenix-workforce/`.

Cycles 1 and 2 searched the repository, git history and merged PR descriptions. They never searched
the place the document was written. That is the miss, and it is worth naming plainly: **"not in the
repository" was treated as "gone", and those are different statements.**

What came back: findings **1–28 and 39–41 complete** (headline, file and line, what breaks, and for
1–5 the proposed fix), and **29–38 and 42–55 as their one-line headlines**. The numbering runs 1–55
with no gaps, which independently confirms the ledger's count.

## Why fourteen findings looked untouched when none of them were

Every search in cycles 1 and 2 looked for the **number**. Not one of the fourteen fix PRs writes
`finding 19` or `finding 28` anywhere. They narrate the defect instead — often in the audit's own
words, sometimes with its own worked example — and never cite it.

`reconcile.ts` says the old check "could only ever pass". `split.ts` reproduces finding 9's worked
case down to the 1,300 EGP. `run-service.ts` records that finding 19's shadow-run defect **actually
occurred on production on 2026-09-10**, ninety seconds before two steps were confirmed against the
shadow run. All of that is the audit, quoted; none of it is searchable by number.

**The lesson is not "cite the finding number", though that would have helped.** It is that a search
for an identifier proves only that the identifier is absent. Absence of a label is not absence of a
fix, and the ledger's "no trace found" rows should have said exactly that and no more.

## The fourteen

Every test below is registered in `tests/run-tests.ts`, so every one of them runs in the required
`validate` check.

| # | What it was | Closed by | Regression test |
| ---: | --- | --- | --- |
| **1** | Outstation trips the wizard paid were never stamped as paid, so the legacy import could pay them a second time. | PR #3641 + migration `20260910160000`, 2026-09-10 | `outstation-import-refuses-wizard-months.test.ts` |
| **6** | 35 held people across two published months, with no record anywhere of what they were owed. | PR #3642, 2026-09-10 | `automated-payroll-settlement-and-held-record.test.ts` |
| **7** | The engine filed the copied `employees.social_insurance` column instead of the insurance wage the statutory rule names. | PR #3659, 2026-09-11 | `payroll-statutory.test.ts` |
| **8** | The Statutory Summary reconstructed a subject wage by dividing the published amount by 11%, putting 88 of 91 people above the legal ceiling. | PR #3659, 2026-09-11 | `payroll-statutory.test.ts` · `payroll-exports.test.ts` |
| **9** | A leaver's frozen first instalment was inflated by his own Part-1 deductions, overpaying him. | PR #3651, 2026-09-11 | `automated-payroll-leaver-overpayment.test.ts` |
| **10** | A leaver's approved unpaid vacation was charged twice — once by shortening his paid days, once as a deduction. | PR #3651, 2026-09-11 | `automated-payroll-leaver-basis.test.ts` |
| **11** | Nothing stopped the same absence day being charged twice on the payroll path; the only guard sat in a step payroll never runs. | PR #3684, 2026-09-11 | `automated-payroll-day-collisions.test.ts` |
| **12** | The Thursday half-day weighting was discarded the moment a reviewer opened the days editor and saved. | PR #3687, 2026-09-11 | `automated-payroll-thursday-half-day-charge.test.ts` |
| **13** | A confirmed deduction figure was latched forever — reversing the decision afterwards still paid it. | PR #3674, 2026-09-11 | `automated-payroll-module-drift.test.ts` |
| **19** | "Start / Resume run" on an already-paid month created a second run that shadowed the paid one everywhere. | PR #3649, 2026-09-11 | `automated-payroll-guards-that-guard.test.ts` |
| **21** | Re-confirming the Part 2 Vacation step handed back the leave-balance days the first confirm consumed. | PR #3669, 2026-09-11 | `automated-payroll-vacation-reconfirm.test.ts` |
| **24** | An interrupted publish could mark the run published over a batch that was never approved, and every retry reported success. | PR #3649, 2026-09-11 | `automated-payroll-guards-that-guard.test.ts` |
| **25** | The step that approves the salary batch never checked whether it actually approved anything. | PR #3649, 2026-09-11 | `automated-payroll-guards-that-guard.test.ts` |
| **28** | The hard "the split does not add up" gate compared a number to itself and could never fire. | PR #3649, 2026-09-11 | `automated-payroll-guards-that-guard.test.ts` |

**Break-and-watch belongs to those PRs, not to this cycle.** Cycles 3 and 4 differ here and the
difference is deliberate: cycle 3 broke each fix and watched its own headline assertion fire, because
those findings were being re-verified. These fourteen were verified when they shipped. What this
cycle establishes is *which* change closed each one and that the test still exists and still runs —
not a second break of work already proven once.

## What was checked on production rather than read

**Finding 1's guard was forced, not inspected.** `phx_period_paid_by_automated_payroll` exists in
production's `pg_proc` — not merely in the migration ledger, which `list_migrations` would have
reported either way — and answers **true** for 2026-07 and 2026-08, **false** for 2026-09, 2026-02
and 2025-12. The legacy import was then called against August inside a `DO` block terminated by
`raise exception`, so the whole transaction rolled itself back. It refused:

```
P0001 :: Payroll batch 2026-8 was produced by Automated Payroll, which pays outstation
         expenses inside the wizard. Importing them here would pay the same trips twice.
```

The December 2025 control — a month with no batch — still ran normally, which proves the function
executes rather than failing for some unrelated reason. Rows in `outstation_expenses` carrying an
`imported_payroll_batch_id`: **0 before, 0 after**, and the transaction rolled back regardless.

**Finding 6's record exists in production.** `automated_payroll_held_settlements` is live with RLS
enabled and four policies, alongside `automated_payroll_carry_forward` (4 policies) and
`automated_payroll_audit`. The publish path writes `held`, `heldFirstPartTotal`,
`heldSecondPartTotal` and `heldWithoutMeaningfulReason` into the published audit row — described in
the source as "the permanent answer to who was held this month, for how much, and why".

## What was still open — closed 2026-09-12 by PR #3786

> **CLOSED.** The owner answered the expense-meaning sheet the same day: stamp the trips automatically,
> at the value HR edited or else the original claim, and treat trips up to June as values only.
> PR #3786 shipped it — `recordPaidExpenseStamp` runs on publish and marks the approved trips of the
> run's payout period, and trips before 1 July 2026 are imported history. July and August are not
> backfilled, so September's publish is the first to mark. The account below is kept as it was written.

**Half of finding 1, deliberately.** The double-payment exposure is closed at the database. The real
repair — stamping the outstation trips whose money the wizard actually paid — was not written, and
the migration says why in its own header: the link does not exist in the data. The wizard's expense
figures are **typed, not derived**. All fifteen non-zero values in the August run were written in a
single save at 2026-09-08 14:09 Cairo, every `expenses_note` is empty, and the figures do not
reconcile to the trips. Saad Mohamed Saad Salama was paid EGP 4,203 of expenses in August while
holding zero trips in August's payout period and 55 unstamped trips spread across 2026-03 .. 2026-09.

**There is no honest way to say which trips that 4,203 settled.** Recording the consumed trips at
confirm time is the real fix, and it needs an owner decision about what the typed figure means. That
decision was the one outstanding item from the whole audit.

## Two decoys — do not "recover" a finding from either

Both use another audit's numbering, and both sit in payroll-adjacent test files where a future search
will find them:

- **`tests/ready-payroll-template-formulas.test.ts:123`** — *"…re-introduce the overpayment finding #1
  fixes."* The comment block about fifteen lines above reads `// Finding #2 (risk-review):`, so that
  file numbers a **risk review**, not this audit.
- **`tests/attendance-manager-view-access.test.ts:101`** — *"resolveAttendanceScopeHrIds — findings
  #19/#20 fix."* Attendance **access scope**, unrelated to payroll findings 19 and 20.

The Direct Orders re-audit's own 1–24 series is a third such decoy and was already recorded in the
ledger.

## The process fix, corrected

Cycle 2 concluded that the audit document must be committed **before** the first fix PR of a cycle.
That stands and is still right. This cycle adds the half it missed:

**A "no trace" verdict must name where it searched, and searching the repository is not enough.** The
session transcripts under `~/.claude/projects/<repo-slug>/` hold the working record of every AI
session on this machine, and an audit produced by one of those sessions lives there whether or not it
was ever committed. Cycle 1 lost fourteen findings for two days to a search that never looked at the
place the document was written.

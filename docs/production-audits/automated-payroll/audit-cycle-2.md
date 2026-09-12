# Automated Payroll — Audit Cycle 2

**Run:** 2026-09-12 · **Findings numbered:** 56 (the series continues from cycle 1, which ended at 55)
**Method:** static analysis of `origin/main` plus read-only production queries
**Cycle 1 record:** [audit-ledger.md](audit-ledger.md)

## Why this cycle exists

Cycle 1 numbered 55 findings. Thirteen of them — **1, 6–13, 21, 24, 25 and 28** — appear nowhere in
this repository: not in code, not in a test, not in git history, not in any pull request. Finding 19
is referenced only as a comparison and was never fixed or dismissed. The audit document that
assigned those numbers was never committed, so the wording of the missing findings cannot be
recovered from anything the company holds.

The owner was offered two routes and chose the second: rather than leave thirteen permanent
asterisks, re-audit the module empirically and find out what is actually broken today.

**This cycle does not recover the thirteen, and nothing could.** The numbering gaps carry no
information about which surfaces those findings covered. What follows is a fresh examination of the
module as it stands, and the finding below is a *new* one — number 56, not one of the missing
thirteen. That distinction is the whole point of writing it down this way.

## Audit surface

`origin/main` at `2d3b8f69c`, read in a clean worktree.

The primary checkout was **14 commits stale** and still contained
`src/lib/automated-payroll/flat-deduction-rate.ts` — a file the 2026-09-12 day-rate ruling (#3752)
deleted. Auditing there would have produced findings about code that no longer ships. Any future
cycle should confirm the surface before reading a line of it.

Machine RAM (2,370 MB free, below the 2,600 MB heavy-job floor) ruled out a dev server, a cold
typecheck and browser verification, so no cycle-2 finding rests on rendered UI.

## Finding 56 — the payroll delete path switched off its own closed-month guards

**Severity:** High · **Status:** Fixed and verified in production, 2026-09-12

### What it was

Three triggers exist to make "a published and announced month is never corrected" mechanical:

| Trigger | Table | Refuses when |
| --- | --- | --- |
| `phx_prevent_closed_salary_batch_delete` | `salary_batches` | status `approved`/`locked`, or Part 1 paid |
| `phx_prevent_closed_salary_records_mutation` | `salary_records` | same |
| `phx_prevent_closed_salary_flags_mutation` | `salary_flags` | same |

All three were enabled in production. All three open by checking
`request.phx_allow_salary_batch_delete` and returning early when it is `on`.

`phx_delete_salary_batch` — the only delete path the application uses — set that flag as its **third
statement**, unconditionally. It then read the batch `for update`, put `status` into its return
payload, and never tested it. Every delete through the application therefore ran with all three
guards disarmed, including for a locked month whose Part 1 had already been paid.

### Why it mattered

Every batch in production was in the state the triggers were written to protect:

| Status | Batches | Part 1 paid | Salary records |
| --- | ---: | ---: | ---: |
| approved | 3 | 1 | 316 |
| locked | 5 | 5 | 580 |

Not one was legitimately deletable. All eight were deletable, along with their 896 salary records
and the payslips built from them. The screen offered it behind a single browser `confirm()`, with
identical wording whether the batch was an unvalidated draft or a locked month that had already paid
people. **Production has no PITR** — seven daily backups are the entire recovery story.

Two things marked this as an oversight rather than a decision. The sibling guard
`phx_prevent_closed_salary_batch_update` — same table, same migration, same purpose — has **no
bypass at all**, and permits only the exact `approved`→`locked` transition with every other column
unchanged. And the delete trigger already allowed deleting draft and rejected batches, so the bypass
bought nothing the legitimate case needed.

### Severity, stated fairly

This was **not** privilege escalation. `assertPermission(access, "payroll", "delete")` held
throughout, and only Super Admin carries it — the owner, plus the documented `admin-HR` canary
account. It was a missing safety interlock on the owner's own destructive action, on the one rule he
treats as golden, with no undo behind it.

### The fix

Owner ruling, 2026-09-12: **refuse it outright.**

The rule applied is the **replace** rule, not the looser trigger rule. Deleting a batch removes the
batch, its `salary_records` and its `salary_flags` outright, so it is strictly more destructive than
replacing one and can never be permitted where a replace is refused. Keeping one definition of
"closed" is deliberate: a second, laxer one is how this class of hole grows back.

| Layer | Change |
| --- | --- |
| Database | `supabase/migrations/20260912120000_payroll_batch_delete_refuses_closed_months.sql` — the RPC raises `P0001` **before** it sets the bypass flag. The bypass remains, because the cascade genuinely needs it for a batch that *is* deletable; it is now unreachable for a closed month. |
| Service | `assertSalaryBatchDeletable` in `src/lib/payroll/service.ts`, called by `deleteSalaryBatch` before the RPC, so the screen gets a 409 naming the month and its stage rather than a raw Postgres error. |
| Screen | `isBatchDeletable` in `src/components/payroll/dashboard/shared.tsx` disables Delete wherever Replace is disabled. The UI had the same asymmetry as the database: Replace was guarded, Delete was not. |

The database is the boundary — it covers every caller, including one that never goes through the
service. The other two layers are for the message and the affordance.

### Verification

Applied to staging first, then production. All three cases exercised on both, inside a transaction
that rolls itself back, against rows created for the test — the RPC was never pointed at a real
batch:

| Case | Expected | Staging | Production |
| --- | --- | --- | --- |
| status `locked` | refuse | REFUSED | REFUSED |
| status `uploaded`, Part 1 paid | refuse | REFUSED | REFUSED |
| status `uploaded`, unpaid | still delete | DELETED | DELETED |

Production row counts after the change: **8 batches, 896 salary records** — unchanged. No test rows
survived on either project.

Regression test: `tests/payroll-closed-month-delete.test.ts`, registered in `tests/run-tests.ts`.
Proven RED against six separate breaks — the delete rule going laxer than the replace rule, the
service falling through to the RPC, the migration refusing after the bypass instead of before it,
the migration keying on status alone, and both halves of the screen guard. Each break fired that
check's own headline assertion.

## What came back clean

An audit that lists only problems says nothing about coverage. These were examined and found sound:

| Class | Result |
| --- | --- |
| Reads that fail open | **0** Supabase errors destructured and never checked, across 153 payroll files |
| Access gates | **35 of 35** mutating payroll routes reach a permission assert |
| Run-phase gates | **19 of 19** Automated Payroll money-writing handlers reach a phase check; all six gaps were in the legacy `/api/payroll/` tree, and finding 56 is one of them |
| Arithmetic | Day-rate divisor fails closed as #3752 ruled; `distributeAmount` absorbs the rounding residual correctly |
| Money handling | No NaN swallowed into a number; no unguarded money divisor |

### A note on the tooling, because it nearly produced three false findings

The first sweep reported 99 unchecked Supabase errors and 27 ungated mutating routes. Both were
artifacts:

- Git Bash collapses `\\b` to `\b` inside single quotes, and JavaScript then reads that as a literal
  **backspace character**, so every word-boundary regex silently matched nothing. `JSON.stringify`
  renders a backspace as `\b` too, which hides it on inspection. Write the script to a file.
- The gate list was missing `assertCopilotAccess`, and the module's convention is
  `resolveAccessContext` at the route with enforcement in the service — not `assertPermission`.

Every headline was checked against the actual file before it was believed. A scan that reports a
catastrophe is more likely to be broken than the code is.

## What cycle 2 does not close — and the ruling that closed it

- **Findings 1, 6–13, 21, 24, 25, 28 remain unaccounted for.** Nothing empirical can recover them.
  They are not "open" and not "fixed" — the record of what they were is gone.
- **Finding 19 still has no established outcome.**
- `tests/payroll-audit-ledger.test.ts` therefore needs no change to its `NO_TRACE` list; the ledger's
  arithmetic for findings 1–55 stands exactly as written.

The decision owed was not technical: whether to accept those fourteen as permanently unrecoverable
and close them on the record, or to keep them open indefinitely.

### The owner ruled on 2026-09-12: close them as permanently unrecoverable.

That ruling is recorded in full in
[audit-ledger.md — The ruling on the fourteen](audit-ledger.md#the-ruling-on-the-fourteen--closed-2026-09-12),
which is the authoritative place for it. In short:

- **No further work is owed on the fourteen.** They are not open items, and no third cycle re-opens
  the question.
- **Nothing is claimed about their content.** Closed is not fixed. The evidence rows still read *no
  trace found in the repository*, deliberately — closing a finding must not erase what was known
  when it was closed.
- **The residual risk is accepted, not removed.** If one of them described a live defect, it is still
  live and there is no description to search for.
- **A future payroll defect is a NEW finding**, numbered from 57 onward. Never attribute one to a
  closed number — the attribution could never be checked.

With that ruling, cycle 2 has no open item. Finding 56 is fixed and verified in production, and the
fourteen are settled on the record.

## The process fix that outlasts both cycles

Cycle 1's findings existed only as code comments and PR descriptions for three days, which is why
thirteen could go missing without anyone noticing. **Write the audit document into
`docs/production-audits/<module>/` before the first fix PR of a cycle, not after the last one.**

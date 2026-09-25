---
name: outstation-import-rpc-would-zero-the-sheet-uploaded-expenses
description: "salary_records.expenses is filled by the payroll XLSX, not outstation - so running phx_import_approved_expenses_to_payroll would WIPE it for everyone without an approved claim and cut their salary"
metadata:
  type: project
---

**Verified live on production (`ozucdzovmcqvepbozvqf`) 2026-08-23.**

`phx_import_approved_expenses_to_payroll` looks like a harmless catch-up for the 361 never-imported
outstation expenses. It is not. Its driving subquery is a **LEFT JOIN over every salary record in the
batch** (prosrc lines 71-74) and line 63 is `set expenses = coalesce(at.approved_expense, 0)`.
Everyone with no matching approved outstation claim is set to **zero**, and `total_additions`,
`second_part` and `month_salary` are all reduced by their old `expenses` value.

**`salary_records.expenses` has a different, independent source.** `src/lib/payroll/salary-import.ts:152`
maps the uploaded payroll XLSX column `"Expenses" | "Expenses Prev Month" | "Expenses (Prev Month)"`
into it. Proof it is not outstation-sourced: **January 2026 carries EGP 21,000 of payroll expenses
while ZERO outstation_expenses rows exist for January at all.**

Live totals: **211 of 796 salary records hold EGP 258,748.50** of expenses across 7 batches.

Simulated against the live July 2026 batch (`b4c3057e-4f16-44f4-9d84-b806676a458c`, status `approved`):
10 of 105 records change, **EGP 19,354 wiped from 9 employees**, EGP 505 added to 1,
**net -EGP 18,849** off July salaries.

**The batch-status gate has been accidentally protecting real pay.** The RPC only accepts
`part1_paid, adjustments_open, part2_ready, under_review, rejected`; production batches are only ever
`locked` (5) or `approved` (2) - zero intersection. See [[outstation-payroll-import-is-locked-out-by-batch-status]].

**Why:** "0 of 361 imported, EGP 141,220.99 outstanding" reads like money owed that a single RPC call
would settle. Opening either gate to release it would instead destroy a larger, unrelated figure.

**How to apply:** never open the batch-status gate or the `accepted_*` gate as a convenience. Any fix
must first make the expense write **additive and hr_id-scoped** instead of a whole-batch overwrite.
Before touching it, re-run the simulation - never trust these numbers as current.

**The "were the stamp columns added late?" caveat is CLOSED and does not matter.** The columns sit at
`attnum` 36-38, before `approved_amount` (40, added 2026-08-01), and no `ALTER ... ADD COLUMN` for them
exists in migration history. More decisively: that RPC is the **only** function in the whole database
whose body mentions either column, every one of the 20 hits in `src/` is a read, and the stamp shares a
single atomic statement with the salary update - so an import can never be unstamped. 0 of 361 is
unconditional. Related: [[outstation-nothing-ever-reaches-accepted-status]], [[outstation-expenses-two-data-models]].

**FIX DRAFTED 2026-08-24 — PR #2362, branch `codex/outstation-import-additive`.** The write is now
additive and hr_id-scoped: an inner join (NO LEFT JOIN anywhere in the function) so an unmatched
record is unreachable by the update, and `approved_totals` sums only rows never yet imported, which
makes a second run a no-op. Rehearsed on staging against a 3-employee fixture — the OLD body zeroed
EGP 5,000 from an employee with no claim and replaced another's EGP 1,000 sheet figure with their
EGP 300 claim, **while returning an identical JSON summary both times**. That invisibility is the
real lesson: the RPC's return value cannot distinguish a good import from a destructive one.

**The batch-status gate is UNCHANGED and the money is still not released.** Every production batch is
`approved` or `locked` — both PAST the import window, not before it, so the old gate message
("before Part 1 is paid") described the wrong end of the lifecycle. Of the EGP 141,221 unimported,
only ~EGP 34,299 passes the payroll-grade approval predicate at all (EGP 30,027 of it July) — the
rest is claimed but never HR-approved. Releasing it is an owner decision, most likely carry-forward
into the next OPEN batch rather than reopening closed months.

**A migration is not applied by merging.** This one must be run against production explicitly, and
that is a protected action needing the owner's go.

---

**STATUS 2026-08-24 — the additive fix is LIVE IN PRODUCTION.** PR #2362 was merged 2026-08-23
21:17 UTC (not by this session) and the migration was applied to prod at 21:19:43 — ledger version
`20260823211943 outstation_import_additive`. **Verified against `pg_proc`, not the ledger:** the
production function now has the additive write, `still_destructive = false`, `has_left_join = false`.
Production data untouched by any of it — 361 outstation rows, **0 stamped, 0 batch-linked**, and the
211 salary rows still hold EGP 258,748.50 exactly. So the destructive version described above can no
longer fire. **Do not "fix" the additive form back.**

**CARRY FORWARD — owner decision 2026-08-24, PR #2364, branch `codex/outstation-carry-forward`.**
`importable` takes every approved never-imported expense at or BEFORE the target period (future
claims still excluded), so an expense whose own month closed rides along with the next open batch.
Cannot double-pay: the same CTE excludes anything already stamped. Ships as a NEW migration
`20260824030000_outstation_import_carry_forward.sql` — 20260824014500 was already merged AND applied,
so editing it would have drifted the file from the live function. **MERGED 2026-08-24 00:29 Cairo, squash `6209cf40`** — all 4 required checks green on the merged
head `b4331638`. **The CODE is live; the MIGRATION is NOT applied to production** (Railway applies
none), so the production function is still the additive-but-not-carry-forward body. That gap is
SAFE and deliberate: the new return keys are read with `?? 0` and their toast lines gated on `> 0`,
so against the old RPC they simply vanish. Verified post-merge — prod still `additive_applied=true`,
`carry_forward_applied=false`, 361 rows / **0 stamped**, EGP 258,748.50 intact.

**Two traps this cost:**
1. **A merged PR's branch gets deleted by GitHub, so a later `git push` silently RE-CREATES it** and
   reports "[new branch]". Reusing it for follow-up work would have made a conflicting PR against the
   squash. Check `gh pr view <n> --json state` before pushing again to a branch you already PR'd.
2. **`sed 's|x|\&\ny|'` replaces the matched line with a LITERAL `&`** instead of keeping it — it
   silently deleted an existing `runTest` registration in `run-tests.ts`. Caught only by reading the
   diff before committing. Use the edit tool for anchored insertions, never sed with `&`.

---

**APPLIED TO PRODUCTION 2026-08-24 00:37 Cairo** — ledger `20260823213741 outstation_import_carry_forward`
(the version never matches the filename `20260824030000`; #2362 landed as `20260823211943` the same way).
Verified against `pg_proc`, not the ledger: `carry_forward_applied=true`, `still_additive=true`,
`has_left_join=false`, `old_exact_period_filter=false`. VOLATILE / SECURITY INVOKER / `search_path=public`
all unchanged and grants preserved (`postgres:EXECUTE, service_role:EXECUTE`) — `create or replace` keeps them.

**Smoke-tested on production without writing a byte, and here is how, because it is reusable.** Call it
for a month with NO batch (`1/2099`): it returns before any write and proves the new return keys exist.
Then call it for a real batch inside a `DO` block with `exception when sqlstate 'P0001'` — the gate raises
before any write. **`execute_sql` does NOT return `raise notice` output**, so a NOTICE-based probe looks
like it passed when it printed nothing; insert into a temp table and SELECT it in the same submission.
Result: gate fired on `7/2026 (approved)` with the message still carrying `cannot import expenses` — the
substring `src/lib/outstation/expenses.ts` matches to raise PayrollConflictError instead of a 500.

**Post-change state: 361 rows, 0 stamped, 0 batch-linked, EGP 258,748.50 across 211 salary records — identical
to before.** `batches_in_import_window = 0`; every production batch is `approved` or `locked`. So carry-forward
is LIVE but pays nobody yet: ~EGP 34,299 is now reachable by the next batch that OPENS, and reaches
backward into no closed month. Opening that gate is a separate owner decision, still not taken.

**Rollback** = re-apply `supabase/migrations/20260824014500_outstation_import_additive.sql`; the live body
before this change matched that file exactly (`md5 4517aa8603102777a50d264859f6995d`, 4852 bytes).

---

**A LEAVER PAID OUTSIDE PAYROLL IS SETTLED BY STAMPING `imported_to_payroll_at` ALONE.** Done in prod
2026-08-24 00:45 Cairo for **Ahmed Nashaat Ali Ahmed (B-175)**, District Sales Manager, resigned
2026-08-03 — 5 HR-approved July claims, **EGP 1,849.00**, paid by final settlement (owner confirmed).

**Why one column and not both.** Every reader in the app tests the OR form —
`imported_payroll_batch_id != null || imported_to_payroll_at != null` — canonicalised in
`isOutstationExpenseInPayroll` ([src/lib/outstation/expense-gate.ts](../../../../../F:/Phoenix%20Workforce/phoenix-workforce/src/lib/outstation/expense-gate.ts)),
and `service.ts` surfaces `imported_to_payroll_at` as `paidAt`. The RPC's `importable` needs BOTH null.
So stamping the timestamp alone marks it paid-and-locked everywhere, while leaving
`imported_payroll_batch_id` NULL truthfully records that **no batch paid it**. Do NOT invent a batch id
to "complete" the pair — it is a FK to a real batch and would fabricate lineage. Put the reason in
`imported_to_payroll_by` (`'final-settlement:B-175'`).

**B-175 had 26 expense rows but only 5 were ever `hr_approved`** — the other 21 (Apr/May/Jun/Jul) were
never approved and so were never payable. Never total a person's outstation rows to get what they are
owed; filter to `hr_approved = true` and use `coalesce(approved_amount, total)` (one of his was adjusted
910 -> 585).

**Effect, verified:** the August-2026 projection went 82 claims / 17 people / EGP 36,403.29 with 1
stranded, to **77 / 16 / EGP 34,554.29 with ZERO stranded**. Salary data untouched (EGP 258,748.50),
`imported_payroll_batch_id` still 0 rows non-null. **Rollback** = set the three columns back to NULL on
ids `5e5c662e`, `32991dcf`, `bb90bb7e`, `5374f8cb`, `e37c9e4c`.

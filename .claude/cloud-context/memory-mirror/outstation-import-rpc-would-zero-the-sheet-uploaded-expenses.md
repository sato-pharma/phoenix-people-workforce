---
name: outstation-import-rpc-would-zero-the-sheet-uploaded-expenses
description: "salary_records.expenses is filled by the payroll XLSX (salary-import.ts), NOT by outstation — so the original whole-batch phx_import_approved_expenses_to_payroll would WIPE it for everyone without a matching approved claim and cut their salary. The fix (additive + hr_id-scoped, inner join, no LEFT JOIN) is LIVE in production; never make that write a whole-batch overwrite again, and never open the batch-status/accepted gate as a convenience."
metadata:
  node_type: memory
  type: project
  originSessionId: 40984f77-33d2-45f9-94fe-bf7b1b13be9d
  modified: 2026-09-26T00:50:49.331Z
---

## The core danger — do NOT reintroduce it

`salary_records.expenses` has its own independent source: the uploaded **payroll XLSX** column
(`"Expenses" | "Expenses Prev Month" | "Expenses (Prev Month)"`) mapped in
`src/lib/payroll/salary-import.ts`. It is **not** outstation-sourced (proof: a month can carry payroll
expenses while having zero `outstation_expenses` rows at all).

`phx_import_approved_expenses_to_payroll` looked like a harmless catch-up for never-imported outstation
claims. Its ORIGINAL body was a **whole-batch LEFT JOIN overwrite** — `set expenses =
coalesce(at.approved_expense, 0)` across every salary record in the batch — so everyone with no matching
approved claim was set to **zero**, and `total_additions` / `second_part` / `month_salary` all dropped by
their old `expenses`. Running it would have destroyed a large, unrelated payroll figure to release a much
smaller outstation one.

🔴 **The fix is LIVE in production and must NOT be reverted to the overwrite form.** The write is now
**additive and hr_id-scoped**: an INNER JOIN (no LEFT JOIN anywhere in the function), and `approved_totals`
sums only rows never yet imported, so a second run is a no-op. Verify the live body against **`pg_proc`,
never the migration ledger** (`has_left_join = false`, `still_destructive = false`).

- **The RPC's return value CANNOT distinguish a good import from a destructive one** — rehearsed on
  staging, the old body zeroed an employee's pay and replaced another's sheet figure with a smaller claim
  **while returning an identical JSON summary both times.** Never trust the RPC's own summary; check the
  data and the function source.
- **How to apply:** never open the batch-status gate or the `accepted_*` gate as a convenience. Any
  future change to the expense write must stay additive and hr_id-scoped, never a whole-batch overwrite.
  Re-run the simulation before touching it — never trust old numbers as current.

## The money is still not released — that gate is an OWNER decision

Every production batch is `approved` or `locked` — both **past** the import window, not before it — so the
batch-status gate has been accidentally protecting real pay ([[outstation-payroll-import-is-locked-out-by-batch-status]]).
Most of the unimported outstation money is **claimed but never HR-approved**; only the HR-approved slice is
payable at all. **Carry-forward is LIVE** (`importable` takes every approved never-imported expense at or
before the target period, future claims excluded, already-stamped rows excluded so it can't double-pay),
**but it pays nobody yet** — it reaches the next batch that OPENS and never backward into a closed month.
Opening that gate is a separate owner decision, still not taken; most likely carry-forward into the next
open batch, not reopening closed months. See [[outstation-nothing-ever-reaches-accepted-status]],
[[outstation-expenses-two-data-models]].

## A leaver paid outside payroll — the durable settlement rule

Settle a leaver's outstation claim that was paid by final settlement (not by a batch) by stamping
**`imported_to_payroll_at` ALONE**:

- Every reader tests the OR form `imported_payroll_batch_id != null || imported_to_payroll_at != null`
  (canonicalised in `isOutstationExpenseInPayroll`, `src/lib/outstation/expense-gate.ts`; `service.ts`
  surfaces the timestamp as `paidAt`), while the RPC's `importable` needs BOTH null. So the timestamp
  alone marks it paid-and-locked everywhere, and leaving `imported_payroll_batch_id` NULL truthfully
  records that **no batch paid it**.
- 🔴 **Do NOT invent a batch id to "complete" the pair** — it is a FK to a real batch and would fabricate
  lineage. Put the reason in `imported_to_payroll_by` (e.g. `'final-settlement:<hr-id>'`).
- 🔴 **Never total a person's outstation rows to get what they are owed** — most rows are often never
  `hr_approved`. Filter to `hr_approved = true` and use `coalesce(approved_amount, total)` (approved
  amounts get adjusted down from the claimed figure).

## Reusable technique — smoke-test an RPC on production without writing a byte

- Call it for a month with NO batch (e.g. `1/2099`): it returns before any write and proves the return
  keys exist.
- Then call it for a real batch inside a `DO` block with `exception when sqlstate 'P0001'`: the gate
  raises before any write.
- 🔴 **`execute_sql` does NOT return `raise notice` output** — a NOTICE-based probe looks like it passed
  when it printed nothing. Insert into a temp table and SELECT it in the SAME submission.

## Two traps this cost

1. **A merged PR's branch is deleted by GitHub, so a later `git push` silently RE-CREATES it** and
   reports "[new branch]" — reusing it for follow-up work makes a conflicting PR against the squash.
   Check `gh pr view <n> --json state` before pushing again to a branch you already PR'd.
2. **`sed 's|x|\&\ny|'` replaces the matched line with a LITERAL `&`** instead of keeping it — it silently
   deleted an existing `runTest` registration in `run-tests.ts`, caught only by reading the diff. Use the
   edit tool for anchored insertions, never `sed` with `&`.

**A migration is not applied by merging** — it must be run against production explicitly (Railway applies
none). New return keys are read with `?? 0` and their toast lines gated on `> 0`, so a merged-but-unapplied
migration is a safe, invisible gap against the old RPC.

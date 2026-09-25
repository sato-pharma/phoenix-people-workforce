---
name: outstation-payroll-import-is-locked-out-by-batch-status
description: "Outstation expenses ARE paid through payroll, but by hand — the import RPC refuses every batch status production actually reaches."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9fa05b22-8835-4510-bdef-6bdf43711c24
  modified: 2026-08-12T00:25:37.644Z
---

Owner confirmed 2026-08-12: outstation expenses **are** paid through Phoenix payroll — they land in
`salary_records.expenses`. But **not one of 360 `outstation_expenses` rows has ever carried
`imported_to_payroll_at`**, and none ever can for a closed period.

`phx_import_approved_expenses_to_payroll(month, year)` accepts batch status
`part1_paid | adjustments_open | part2_ready | under_review | rejected`. Every batch in production is
`locked` (2026-01/03/04/05/06) or `approved` (2026-02/07) — both **outside** that window, and
`locked` is terminal (`src/lib/payroll/workflow.ts:73`). The "Import to payroll" button on
`/admin/outstation/expenses` therefore raises *"Payroll batch cannot import expenses … while status
is %"* every time.

**Why:** someone carries the figures across by hand. For the July 2026 run they matched the module's
approved totals to the pound for 12 of 14 employees.

**How to apply:**
- Never say "expenses were never paid" from `imported_to_payroll_at IS NULL` alone — check
  `salary_records.expenses` first. Jan–Jul 2026 paid EGP 258,748.50 that way.
- Hand-carry has already dropped **EGP 2,594** (A-12 240 · B-74 505 · B-175 1,849 — the last has no
  July salary record at all). Measured 2026-08-12, not yet ruled on by the owner.
- **`salary_records.expenses` is a SUPERSET of outstation** — July alone carried EGP 19,354 for 9
  people with no outstation row. The RPC does `SET expenses = …`, so switching the import on without
  making it **additive** would erase all of it.
- Any fix is a payroll-module change as much as an outstation one — see
  [[outstation-expenses-two-data-models]].

Full evidence: `OUTSTATION_EXPENSES_AUDIT.md` §5.6 in the repo.

## 2026-08-23 — CONFIRMED against production, and it is bigger than this file said.

Verified live on `ozucdzovmcqvepbozvqf` (ref resolved with `list_projects`), reading the function body
from `pg_proc` rather than from a migration file.

**The gate.** `phx_import_approved_expenses_to_payroll(p_month, p_year)` line 31:

    if v_batch.status not in ('part1_paid','adjustments_open','part2_ready','under_review','rejected')
      then raise exception 'Payroll batch cannot import expenses before Part 1 is paid or while status is %.'

**What production actually holds.** Every `salary_batches` row rests in `locked` (5) or `approved` (2).
Neither appears in the accepted list, so **the two sets do not intersect today.** The live July 2026
batch is `approved` and its `part1_paid_at` is **null** — it never reached the importable state at all.
The other six do carry a `part1_paid_at`, but each was created and finalised the same day
(2026-05-13, 06-10, 07-13), so the window never meaningfully stood open.

**The result, and this is the number that matters:**

| payout | rows | imported | EGP |
| --- | --- | --- | --- |
| 2026-09 | 15 | **0** | 8,165.53 |
| 2026-08 | 10 | **0** | 8,156.11 |
| 2026-07 | 79 | **0** | 33,363.00 |
| 2026-06 | 62 | **0** | 25,209.35 |
| 2026-05 | 80 | **0** | 30,986.00 |
| 2026-04 | 60 | **0** | 18,646.00 |
| 2026-03 | 53 | **0** | 15,758.00 |
| 2026-02 | 2 | **0** | 937.00 |
| **total** | **361** | **0** | **141,220.99** |

`imported_to_payroll_at` and `imported_payroll_batch_id` are **null on all 361 rows**. The automated
import has never once succeeded in production, across eight payout months.

**How to apply.** This is not a dormant edge case — it is EGP 141k of real reimbursements moved by
hand, every month, on a system whose owner has said plainly that he does not do manual work. Treat it
as live remediation, not documentation. **One caveat before acting:** null stamps would also result if
those two columns were added after an earlier import mechanism ran, so confirm no pre-column import
path existed before concluding "never". See [[outstation-nothing-ever-reaches-accepted-status]] — the
release gate that feeds this one refuses anything not `accepted_*`, and exactly one row qualifies.

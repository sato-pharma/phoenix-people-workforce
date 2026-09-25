---
name: rule1-sos-migrations-applied-to-prod-2026-08-14
description: "Three Rule #1 migrations are LIVE on production (2026-08-14): closing_fact reads SoS, the vs-target SQL floor is January, 8 legacy objects dropped and legacy writes revoked. Do not redo or undo."
metadata: 
  node_type: memory
  type: project
  originSessionId: b999e9ef-030a-4843-87cb-dfb024f13c09
  modified: 2026-08-14T00:45:29.914Z
---

**Applied by hand to production `ozucdzovmcqvepbozvqf` on 2026-08-14, with the owner's explicit
approval ("verify against production first, then apply all three"). Do NOT re-apply, and do NOT
revert.**

**The code caught up on 2026-08-14: PR #2111 merged as `eeee560d` and production served it within
two minutes** (healthz `revision` = `7ec03748`, which contains it — PR #2112 merged 2s later and its
deploy won the race; both carry the merge). Schema and code are no longer out of step, so the raw
`permission denied` on `/sales/import` is closed. Verified live after the deploy: B-158 H1 canonical
**460,228.50** vs legacy 700,019.87, all 6 retired objects gone, `sales_records` +
`v_employee_portal_sales` still present.

| Migration | What changed | Proof taken after applying |
| --- | --- | --- |
| `20260814090000_closing_fact_reads_source_of_sales` | `analytics.closing_fact` now reads `au.f_monthly_achievement` instead of `sales_records`; `cross_source_period_line` + `analytics_cross_source(text,text,text[])` dropped/recreated **one column shorter** (the "Close vs SoS %" gap column is gone) | 6,592 rows / **70,056,568.95**, periods 2026-01…2026-08, `batch_file='source-of-sales-monthly-closing'`. Legacy signature was 11,267 / 54,922,998.84 |
| `20260814110000_sales_vs_target_range_reads_from_january` | `au.f_sales_vs_target_range` data floor `2026-07-01` → `2026-01-01` | `('2026-01','2026-06')` now returns all six months (7.81M Jan … 9.37M Jun); it returned **zero rows** for any pre-July range before |
| `20260814120000_retire_legacy_sales_engine_objects` | dropped 4 views + 4 functions; revoked INSERT/UPDATE/DELETE/TRUNCATE on `sales_records` and `v_employee_portal_sales` | all 8 `-- GONE --`; `sales_records` → `authenticated: SELECT`, `service_role: SELECT,REFERENCES,TRIGGER` |

**Three things that look like bugs and are not:**

1. **`sos_value` equals `closing_value` exactly** at (period, line) grain — 2026-07 CNS reads
   8,066,152.47 on both legs. That is by construction: attribution redistributes a line's value
   *down* it, never between lines, so once the closing leg is attributed SoS the gap is always
   0.00%. This is why the gap column was removed rather than kept. Do not "restore" it.
2. **June shows sales but `target_value` is NULL** → `closing_achievement_pct` NULL, never 0.
   Targets are gated on the distributor-upload ledger, and H1 targets are not backfilled yet
   (Phase 5, blocked on the owner's rulings XLSX).
3. **Head Office has SoS value but no closing value** — LA003/LA004/SS001 are the whole line and
   stay excluded as confidential. Unchanged from the old definition.

**What is still writable on purpose:** `sales_import_batches` keeps full write grants so the
`/sales/import` console can still approve/reject/replace/delete existing batches. Because
`sales_records_batch_id_fkey` is ON DELETE CASCADE and Postgres runs RI actions with the *table
owner's* privileges, deleting a batch still cascades rows out of `sales_records` even with DELETE
revoked. **The revoke stops direct writes; it is not immutability and must not be described as
one.** `phx_reassign_replacement_ownership` (SECURITY DEFINER, owner `postgres`) also still updates
`sales_records` by design — verified unbroken after the revoke.

**Why:** the two engines disagreed for the same person in the same month (+8% company-wide H1,
−34% for rep B-158), which is exactly what
[[sos-monthly-closing-is-the-only-sales-truth]] exists to prevent.

**How to apply:** if a later session finds `closing_fact` back at 54,922,998.84, something reverted
these — re-apply rather than "fix" the view. Assert on the number, not on object existence
([[migration-file-written-is-not-migration-applied]]).

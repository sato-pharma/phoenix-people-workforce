---
name: a-price-fix-silently-restates-every-published-closing
description: "Changing a factory price in source_of_sales_products re-values EVERY period back to January, published ones included. The drift check now SEES value (fixed 2026-09-05) but the price is still outside the closing lock and publishing still takes no snapshot. Owner ruled 2026-09-04 that July 2026 Anti Infective stays as published - do not re-issue it."
metadata:
  type: project
---

`phx_monthly_closing_matrix` recomputes `sales_value` live as `sum(effective_units × factory_price)`
against the **current** product master. So a price correction restates every closed month at once.
**That is INTENDED** — the owner rejected period-scoped prices outright
([[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]]). The defect was never the
re-valuation; it was that it happened invisibly.

Measured 2026-09-04 when Royafloxacin `RO001` went 60.75 → 60.70 (owner: the correct price is
60.70). Eight periods moved, 1,017.10 EGP in total; July −80.75, August −91.40.

**Half of the blindness is FIXED (2026-09-05, PR #3199, applied to staging and production).**
`phx_closing_publication_snapshot` and `phx_lock_monthly_closing` now record **value** per cell
(direct rows take `direct_value`, never units × factory price), and
`phx_closing_publication_drift` compares value **and** units. It also **falls back to the
`monthly_closing_locks` snapshot**, because it used to read `monthly_closing_publications` — which
**nothing has ever written a snapshot into** — so it returned its `(no snapshot)` sentinel for every
line and period while the lock table held 14 of 14 populated snapshots. Proven by breaking it:
TE003 81.00 → 80.95 on staging flagged 49 cells and −558.80 EGP with `units_delta = 0` on every one.
**Aggregate both sides per cell before comparing** — the lock dumps raw rollup rows while the
snapshot groups, and 7,201 production cells hold more than one row (worst 546).

**Two gaps remain open.** `phx_reject_write_to_locked_closing` guards 5 sales/rollup tables but
**still not `source_of_sales_products`** — the price sits outside the lock, confirmed 2026-09-05 by
editing a price against a locked closing with no objection. And **publishing still takes no
snapshot**: all 3 published rows have every snapshot column NULL, so drift is only detectable for a
line that was also *locked*. Pre-existing snapshots carry no value and correctly say so rather than
reporting a fabricated 100% value drift.

🔴 **OWNER DECISION 2026-09-04: July 2026 Anti Infective STAYS as published.** It is the only
published Anti Infective month; the managers' copy reads 80.75 EGP above the system, 0.08% of that
line. Re-publishing notifies every sales and product manager and a sent mail cannot be recalled.
**Do not "correct" it, and do not offer to.** For the same reason existing snapshots were
deliberately **not** back-filled — a snapshot taken now would record the already-restated figures as
the published baseline. See [[sos-monthly-closing-is-the-only-sales-truth]] and
[[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]].

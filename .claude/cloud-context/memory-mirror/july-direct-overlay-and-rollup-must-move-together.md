---
name: july-direct-overlay-and-rollup-must-move-together
description: "Direct sales are REGION-grained in the closing; July's area detail lives only in the hardcoded TS overlay, and changing it or the DB alone silently reverts the month to region-only"
metadata: 
  node_type: memory
  type: project
  originSessionId: fdc8c238-3c90-4c5c-806a-c59514e3414d
  modified: 2026-08-10T08:50:04.516Z
---

The closing's direct-sales RPC returns `MonthlyClosingDirectCell` = **region × product only**
(`src/lib/sales/monthly-distributor-import.ts`). Writing `area_code` onto a direct
`source_of_sales_import_rows` row does **not** make the closing show it by area — the RPC groups by
region regardless. July 2026's area detail exists only in the hardcoded overlay
`src/lib/sales/july-2026-direct-orders.ts`.

`resolveJulyDirectByArea` merges that overlay into the matrix **only if the overlay's value total
equals the RPC's to within 0.01, per line**. Otherwise it returns `null` and the month silently
renders region-only. There is no error, no warning, no log line.

**Why:** the two are descriptions of one month at different grains; merging a stale one would move
the month's reported total. Falling back is recoverable, a wrong total is not — so the guard fails
closed and quietly.

**How to apply:** any change to July direct money is TWO writes that must land together — the
production rows (+ `phx_refresh_sos_fact_rollup(batch_id)`) and the overlay file. Change one and
the closing looks "fine" while quietly dropping every area. After a DB-only write, the areas stay
missing until the code deploys.

**ORDER MATTERS — do the DB write LAST (learned 2026-08-10, it cost the owner a confused
screenshot).** The DB write is instant; the overlay needs a PR, green CI and a merge. Writing the
DB first opens a window in which every area row collapses into per-region "◆ DIRECT — Direct orders
(company)" rows, and that is what the owner sees on the closing while he waits. Totals stay right,
so nothing looks broken enough to explain itself. Sequence it: edit the overlay, push, get the four
required checks green, then apply the DB write and merge back to back. Also expect
`tests/july-2026-direct-orders-tab.test.ts` to fail — it hard-pins `TOTAL_VALUE`/`TOTAL_UNITS`,
`PEDIA_VALUE`/`PEDIA_UNITS` and the Giza-scope total, so repin all of them in the same PR. Verify by summing the overlay per line and comparing against
`source_of_sales_fact_rollup` for period 2026-07, `is_direct`, batch `1f699277-…` — they must match
to the piastre. See [[direct-order-pricing-rule-locked]]: value is always carried as supplied,
never recomputed at factory price.

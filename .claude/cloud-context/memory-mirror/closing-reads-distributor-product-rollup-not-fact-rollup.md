---
name: closing-reads-distributor-product-rollup-not-fact-rollup
description: "The Monthly Closing screen reads source_of_sales_distributor_product_rollup, NOT source_of_sales_fact_rollup - a backfill that writes only the fact rollup is invisible on screen. That rollup excludes direct orders ON PURPOSE, because the closing adds them back through a SECOND RPC (phx_monthly_closing_direct) - so quoting the rollup alone as \"what the closing shows\" understates the month, and flipping its filter double-counts"
metadata:
  type: project
---

**There are TWO parallel sales rollups and they can silently disagree.** `loadMonthlyClosingParts`
(`src/lib/sales/monthly-distributor-import.ts`) calls **`phx_closing_distributor_product`**, which
reads **`source_of_sales_distributor_product_rollup`** — a pre-aggregated table by
distributor/region/area/product that has **NO `client_code`**. `phx_monthly_closing_matrix` reads
`source_of_sales_fact_rollup` instead. **The closing screen and every export use the FIRST one.**

So a customer-level correction written into `source_of_sales_fact_rollup` changes nothing the owner
can see. That is exactly what happened on 2026-08-26: migration
`20260826190000_sos_even_split_ez.sql` taught `phx_refresh_sos_fact_rollup` to spread EZ
(client `1011654`) across the 8 CNS Cairo+Giza roster seats and backfilled Feb–Jul 2026, but never
chained `phx_refresh_sos_distributor_product_rollup`. The closing kept showing EZ 100% on
Heliopolis: **+2,318.75 units / +243,918.11 EGP** there, each of the other 7 seats short
**331.25 units / 34,845.44 EGP**. Heliopolis read 123.8% achievement instead of 52.1%. The owner
spotted it because units moved in one view while **value never moved** in the closing.

**Why:** `phx_refresh_sos_distributor_product_rollup(batch_id)` derives the whole table from
`source_of_sales_fact_rollup`, so it must run AFTER every fact-rollup rebuild. All four app call
sites already pair them (`monthly-distributor-import.ts`, `normalizer/service.ts`,
`normalizer/mapping.ts`, `normalizer/customer-map.ts`). Only hand-run backfills and migrations
forget — and nothing warns you.

**How to apply:** After ANY write to `source_of_sales_fact_rollup`, call
`phx_refresh_sos_distributor_product_rollup` for the same `batch_id`. Before believing a sales
correction landed, diff the two tables at (batch, line, period, distributor, region, area, product)
grain — the refresh function's own filters are `status='validated'`, `not is_direct`, and product
not in `('LA003','LA004','SS001')`. Replaying the app's writer is far safer than hand-written UPDATEs:
net unit delta must be **0.000** per batch, since the split only moves units between areas.
Note `phx_reject_write_to_locked_closing` blocks this for a locked period — unlock with
`phx_unlock_monthly_closing(line, period, actor, reason)` and re-lock with `phx_lock_monthly_closing`;
the lock snapshot is taken from `source_of_sales_fact_rollup`, which this repair does not touch, so
the resealed snapshot is byte-identical. See [[sos-monthly-closing-is-the-only-sales-truth]] and
[[ez-is-credited-evenly-across-cairo-giza-cns-reps]].


## The closing DOES count direct orders — through a SECOND RPC, so never flip the rollup's filter

`phx_refresh_sos_distributor_product_rollup` carries a literal **`and not coalesce(f.is_direct,
false)`**, and that exclusion is CORRECT: the distributor-product rollup is the distributor
invoice half only. The closing composes **two** reads —
`phx_closing_distributor_product` (invoice lines) **plus `phx_monthly_closing_direct`**, which
reads `source_of_sales_fact_rollup` where `is_direct`, honours the row's own `area_code` for every
period but `2026-07`, and is folded in by `injectDirectIntoMatrix`. **Flipping the rollup filter
DOUBLE-COUNTS every direct order** — the same trap already recorded for `includedInClosing` in
[[direct-orders-were-labelled-excluded-from-a-closing-holding-them]].

**Why:** on 2026-09-05 I reconciled the owner's manual Anti Infective August workbook against
`source_of_sales_distributor_product_rollup` ALONE, found his 3,104 / 2,188 against its 2,983 /
1,828, and told him the closing was leaving 460 direct units out and that including them was his
decision. It was not: `phx_monthly_closing_direct('Anti Infective','2026-08')` already returned all
six cells — 460 units, 34,978.90 EGP, on CA4 / D13 / D16 / UE2 — and `au.f_monthly_attribution`
already credited them to reps B-161, B-7, B-107 and B-79. The whole claim came from reading one
half of a two-part composition, and it contradicted a memory written eleven days earlier.

**How to apply:** the closing's units for a (line, period) are **distributor-product rollup +
`phx_monthly_closing_direct`**. Query BOTH before calling any manual-vs-Phoenix gap an error, and
never quote the distributor rollup on its own as "what the closing shows". See
[[direct-orders-are-counted-in-the-month-finance-books-them]].

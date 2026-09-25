---
name: sos-file-vs-db-gaps-are-ignore-mapped-products
description: "Comparing a source file's total against the database always shows a false shortfall — IGNORE-mapped products and grand-total rows explain it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 03cc2804-3d96-4252-be34-4b96ec5c0d6f
  modified: 2026-08-05T12:20:16.305Z
---

Summing a distributor file's `Qty` column and comparing it to the stored batch **will always look
short**, for two reasons that have nothing to do with a bad import:

1. **IGNORE-mapped products.** Products the company does not sell are aliased to `IGNORE` for the
   distributor (`source_of_sales_product_aliases.product_code = 'IGNORE'`). For distributor `PS`
   there are 8, set 2026-07-02: `6695` سى فيت, `35098` فونوبيب, `13512`/`19295` ترينسيديا,
   `36790` هيل كويك, `47057` لاكتو ال اف, `5976` كليروفات, `52075` ايلدكيد. February 2026 drops
   **1,977 rows / 6,665 units** to this list alone — which looked like a 4.9% missing month until
   the batch's own `rows_ignored` column explained it.
2. **A grand-total row.** Several exports carry a bottom row with a blank customer holding the
   sheet's own total, which makes the file appear to have exactly double the units. Phoenix drops
   it (blank customer), so it never inflated the database. The 51,565,858.35 "blank branch" row in
   the July POS file is this, not a sale.

**The reliable check is the batch record, not the file.** `source_of_sales_import_batches` reconciles
exactly: `scannedDataRows = coded + ignored + blankCustomerSkipped`, with `rows_ignored` naming the
gap. February: 25,456 = 23,478 + 1,977 + 1, 0 exceptions — correct, not short.

To see *which* products were dropped and why, re-run the normalizer read-only over the file and print
`result.ignoredRows` grouped by product (`reason` is `ignore_mapped` or `bonus`).

Related: [[sos-distributor-folder-labels-are-unreliable]].

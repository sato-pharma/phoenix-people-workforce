---
name: closing-uses-total-qty-not-effective-units
description: "Reconciling the Monthly Closing with SQL over source_of_sales_fact_rollup must sum total_qty — effective_units is a different number and produces phantom gaps"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 03cc2804-3d96-4252-be34-4b96ec5c0d6f
  modified: 2026-08-05T12:20:25.278Z
---

`source_of_sales_fact_rollup` carries **two** unit columns, and they are not interchangeable:

- `total_qty` — what the Monthly Closing reports.
- `effective_units` — a different figure that can diverge by ~2%.

Summing `effective_units` to "independently verify" the closing invents a discrepancy that is not
there. Measured 2026-08-05 on CNS:

| Month | `effective_units` | `total_qty` | Closing shows |
| --- | --- | --- | --- |
| 2026-03 | 90,160.35 | 90,167 | 90,167 |
| 2026-04 | 84,051.27 | 85,654 | 85,654 |
| 2026-05 | 113,818.17 | 113,818.17 | 113,818 |

April's 1,602.73-unit "gap" was entirely this column choice — it looked like a real April-specific
data fault right after an April re-import, which is exactly when a false alarm is most expensive.

Also remember the closing excludes confidential products `LA003`/`LA004`/`SS001`, which carry a
large share of volume (April 2026: 212,826 of 346,723 units). Any total that ignores that exclusion
will not match the closing either.

Related: [[sos-file-vs-db-gaps-are-ignore-mapped-products]].

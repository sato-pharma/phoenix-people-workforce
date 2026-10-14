---
name: head-office-sales-are-absent-from-phx-monthly-achievement
description: "phx_monthly_achievement returns no rows for Head Office products, so any report built on it renders 243,579 real July units as zero — but Head Office IS priced in source_of_sales_import_rows.value (Lacto Basic 209.25): about 41M pounds a month in 2026, so a company total without it understates Sato about 4.5 times"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-10-13T20:06:41.216Z
---

**`phx_monthly_achievement(period)` covers the graded lines only. Head Office products come back
with NO ROWS — which is not the same as zero sales, and must never be rendered as zero.**

Caught 2026-08-27 while building the Monthly Closing "All Products by Month" tab. The tab was built
on the achievement RPC, so it printed Head Office as having sold nothing. The truth, from
`source_of_sales_fact_rollup` for `2026-07`:

| Family | Code | July units |
| --- | --- | --- |
| Lacto Basic | LA003 + LA004 | **243,232** |
| Satoslim | SS001 | 336 |
| Royanoxicam | RY001 | 11 |
| | | **243,579 total** |

That is roughly **double** the entire tracked-line July volume (125,933 units) being reported as
zero. Owner rule: when a data source does not cover something, say so — never show a misleading zero.

**Two further traps in the same area:**

- **Royanoxicam is the exception that makes the rule look wrong.** It DOES come back from the RPC
  (11 units / EGP 462) but with `line_code = NULL`, while Lacto Basic and Satoslim return nothing at
  all. So "does the RPC return Head Office?" has no single answer — resolve the line from
  `source_of_sales_products.normalized_line`, never from the RPC's `line_code`.
- **`fact_rollup.direct_value` is NOT the sales value.** It is the direct-order portion only. For
  LA001 July it reads 945,972 against the RPC's 1,496,502. Head Office rows have
  `direct_value = 0`, so there is **no priced value available for Head Office at all** — units are
  the only honest measure. Show `—` for value/target/achievement, and keep `·` meaning a genuine
  zero; the two marks must never be interchangeable.

**Presentation decision taken 2026-08-27:** Head Office sits in its own block BELOW the tracked-lines
total and is never added into it, mirroring the weekly rule. Nothing is dropped, nothing is summed
that should not be.

**Correction, 13 Oct 2026: Head Office DOES have a priced value. The "no priced value" line above
is true only of the achievement RPC and `fact_rollup`.** `source_of_sales_products.factory_price`
is 209.25 for Lacto Basic 1 and 2, and 190.08 for Satoslim. `source_of_sales_import_rows.value` is
filled for every Head Office row. For January to September 2026 it gives Head Office about 41
million pounds a month, against about 11.7 million for the three tracked lines together. A
company-wide sales figure that leaves Head Office out understates Sato about four and a half times.
The owner caught exactly that in a company-profile draft ("LactoBasic … alone sells with almost 33
million a month"). For a company total, sum `import_rows.value`, or `qty × factory_price`, across
ALL lines.

Related: [[head-office-products-are-not-tracked-weekly-golden-rule]],
[[lacto-advanced-and-basic-share-family-and-family-code]],
[[sos-monthly-closing-is-the-only-sales-truth]].

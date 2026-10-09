---
name: the-two-sales-rollups-store-units-only-never-value
description: "`source_of_sales_distributor_product_rollup` (`units_qty`/`eff_units`) and `source_of_sales_fact_rollup` (`total_qty`/`effective_units`) hold UNITS ONLY — `direct_value` is not the sales value and there is no value column; comparing a raw-row `sum(value)` against a rollup unit sum manufactures a discrepancy that does not exist, which on 2026-10-09 nearly became a report to him that the closing and the rows disagreed by 1,571.02 EGP."
metadata:
  node_type: memory
  type: project
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
---

Measured 2026-10-09 while proving the eight Sohag 1 → Sohag 2 customer moves had reached the layers
the Monthly Closing reads.

The alarm was that Sohag 1's September CNS raw rows summed to **847,786.09** while the rollup showed
**11,478.39** — read as a stale rollup. They are the same data: 847,786.09 is **EGP**, 11,478.39 is
**units**. Compared like with like, every layer agrees to six decimal places:

| Layer | Sohag 1 (UE5) | Sohag 2 (UE6) |
| --- | --- | --- |
| `source_of_sales_import_rows` `sum(qty)` | 11,478.388394 | 2,997.404660 |
| `..._distributor_product_rollup` `units_qty` / `eff_units` | 11,478.388394 | 2,997.404660 |
| `..._fact_rollup` `total_qty` / `effective_units` | 11,478.388394 | 2,997.404660 |

**Why:** neither rollup carries a value column. Value is derived at read time from the period price
(`phx_factory_price`), so a value comparison at the rollup layer needs the price table joined in —
and `source_of_sales_fact_rollup.direct_value` is the direct-order value only, never the line's sales
value. See [[head-office-sales-are-absent-from-phx-monthly-achievement]], which is the same trap
one layer up.

**How to apply:** compare **units to units** across these layers, or join the price and compare
value to value — never one against the other. Before reporting that a rollup is stale, run the
contradiction count instead: join the rows to `source_of_sales_customer_map` on
(`distributor_code`, `customer_code`) and count where `r.area_code is distinct from m.area_code`.
That is the test for "has a customer move propagated", and it returned **zero** for Sohag 1/2 on
every tracked line in September 2026. Head Office contradictions **are** expected to remain there —
it is tracked in no closing at all. Related:
[[a-line-scoped-re-resolve-leaves-the-other-lines-contradictions]],
[[sos-monthly-closing-is-the-only-sales-truth]],
[[head-office-products-are-not-tracked-weekly-golden-rule]].

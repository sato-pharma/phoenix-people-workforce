---
name: closing-retail-value-is-units-times-factory-price
description: "The closing's RETAIL value is effective_units × source_of_sales_products.factory_price — editing source_of_sales_import_rows.value changes nothing on the closing, and factory_price has no period scoping"
metadata: 
  node_type: memory
  type: reference
  originSessionId: fdc8c238-3c90-4c5c-806a-c59514e3414d
  modified: 2026-08-06T14:38:21.111Z
---

`phx_monthly_closing_matrix` computes:

```sql
sum(f.total_qty)                                      as sales_units,
sum(f.effective_units * coalesce(p.factory_price, 0)) as sales_value
```

joining `source_of_sales_products` **live** at query time. So for RETAIL (`not is_direct`):

- The row's own `value` column is **never read** by the closing. Editing
  `source_of_sales_import_rows.value` to fix a closing figure does nothing visible and silently
  desynchronises the audit surface from the closing. (Cost a wrong edit to 508 rows on 2026-08-06,
  reverted.)
- The price lever is `source_of_sales_products.factory_price`.
- Because products are joined live, changing `factory_price` needs **no rollup refresh** — it takes
  effect on the next read.

**Why it matters:** `factory_price` is one value per product with **no period scoping and no price
history table**. Changing it restates *every* month at once. Measured for RO001 on 2026-08-06, a
60.75 → 60.70 change moved Jan–Jul 2026 by −918.85 in total (July alone −80.75). A "fix July's
price" request therefore cannot be satisfied without a migration plus a rewrite of
`phx_monthly_closing_matrix`.

**How to apply:** before changing any closing money figure, check whether the number is
units × factory_price or a carried value. DIRECT is the opposite case — it carries `direct_value`
exactly as submitted and is never recomputed at factory price (see
[[direct-order-pricing-rule-locked]] and
[[july-direct-overlay-and-rollup-must-move-together]]). Owner ruled 2026-08-06 to leave RO001 at
60.75 rather than restate six closed months for EGP 918.85.

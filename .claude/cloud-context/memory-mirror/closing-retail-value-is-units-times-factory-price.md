---
name: closing-retail-value-is-units-times-factory-price
description: "The closing's RETAIL value is effective_units × the factory price for that PERIOD — phx_factory_price(code, period) reads a source_of_sales_product_price_history override (SA001 170.52 from 2026-10) and falls back to the flat source_of_sales_products.factory_price. Editing source_of_sales_import_rows.value changes nothing on the closing, and a master factory_price edit still restates every month with no override."
metadata: 
  node_type: memory
  type: reference
  originSessionId: fdc8c238-3c90-4c5c-806a-c59514e3414d
  modified: 2026-10-02T16:33:38.191Z
---

`phx_monthly_closing_matrix` computed (as of 2026-08-06 — the price now resolves per period, see the
price-lever bullet below):

```sql
sum(f.total_qty)                                      as sales_units,
sum(f.effective_units * coalesce(p.factory_price, 0)) as sales_value
```

joining `source_of_sales_products` **live** at query time. So for RETAIL (`not is_direct`):

- The row's own `value` column is **never read** by the closing. Editing
  `source_of_sales_import_rows.value` to fix a closing figure does nothing visible and silently
  desynchronises the audit surface from the closing. (Cost a wrong edit to 508 rows on 2026-08-06,
  reverted.)
- The price lever is the price **for that period**: `public.phx_factory_price(product_code, period)`
  reads `public.source_of_sales_product_price_history` and **falls back to the master
  `source_of_sales_products.factory_price`** when no override row covers the period. On 2026-09-28 the
  history table held one row — `SA001` from `2026-10` at 170.52 — and 31 closing/attribution/dashboard
  functions were repointed at the resolver (PR #4630); see
  [[saginko-repriced-retail-from-october-direct-from-today]].
- Because products are joined live, changing a price needs **no rollup refresh** — it takes
  effect on the next read.
**Superseded 2026-10-02:** previously "the price lever is `source_of_sales_products.factory_price`" alone — the period-scoped resolver of 2026-09-28 (`saginko-repriced-retail-from-october-direct-from-today`, rule "A PRICE CAN NOW DIFFER BY PERIOD").

**Why it matters:** the master `factory_price` column is still one value per product with no period
scoping, so **editing the master restates every month that has no override row**, published ones
included. Measured for RO001 on 2026-08-06, a 60.75 → 60.70 change moved Jan–Jul 2026 by −918.85 in
total (July alone −80.75). A period-scoped price change goes in as a
`source_of_sales_product_price_history` row read through `phx_factory_price`, never as a flat master
edit (for SA001 a flat edit to 170.52 would restate Jan–Aug by +1,814,407 EGP, two of them published).
**Superseded 2026-10-02:** previously "no period scoping and no price history table; a 'fix July's price' request needs a migration plus a rewrite of `phx_monthly_closing_matrix`" — that history table and resolver now exist (owner, 2026-09-28; rule "A PRICE CAN NOW DIFFER BY PERIOD").

**How to apply:** before changing any closing money figure, check whether the number is
units × factory_price or a carried value. DIRECT is the opposite case — it carries `direct_value`
exactly as submitted and is never recomputed at factory price (see
[[direct-order-pricing-rule-locked]] and
[[july-direct-overlay-and-rollup-must-move-together]]). Owner ruled 2026-08-06 to leave RO001 at
60.75 rather than restate six closed months for EGP 918.85.

---
name: sales-marketing-product-code-namespaces
description: "Sales and Marketing product codes are UNIFIED (sales is canonical) as of PR #763 — history of the old divergence and the guard against regression"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 79edc018-f0ed-43ae-a1f8-31ecd901936e
---

**RESOLVED 2026-07-03 (PR #763):** Sales (`source_of_sales_products.product_code`) is now the single reference for product codes. Migration `20260703310000_unify_marketing_product_codes_with_sales.sql` renamed all 21 `marketing_products` rows to their matching sales code (20 exact name+line matches + 1 explicit typo mapping: marketing's "Tebofrtin drops" → sales' "Tebofotin drops" = `TE001`). `marketing_request_products` references `marketing_products` by surrogate `id`, not `product_code`, so historical request rows were unaffected by the rename.

**Going forward:** a `product_scope_override` needs only ONE code per product (not two) — e.g. A-10's `[SA001,RO001]` now also matches marketing automatically. New products must be created with the SAME code in both `source_of_sales_products` and `marketing_products` (sales issues the code; 2-letter-prefix + 3-digit convention, e.g. `SA001`). `reference-importer.ts`'s `seedMarketingReferenceData` (the one-off local-script reseed at `scripts/seed-marketing-reference-data.ts`) now auto-reconciles against the sales catalog before upserting (`reconcileProductCodesWithSalesCatalog`, with a small name-alias map for the one known typo), so a future reseed can't reintroduce MKT_PRD#### divergence — but any OTHER manual insert into `marketing_products` must still deliberately reuse the sales code.

**Prior state (context only, no longer true):** before this fix, `marketing_products.product_code` used independent `MKT_PRD####` codes (e.g. Saginko was `SA001` in sales but `MKT_PRD0016` in marketing) — a `product_scope_override` with only sales codes silently hid all marketing visibility. See [[b155-two-line-pm-scope]].

Schema notes: `marketing_products.id` is IDENTITY (auto); `line`/`line_id` present (Pedia=2, Anti infective=1, CNS=3); UNIQUE constraint on `product_code`. `source_of_sales_products`: many NOT NULL text cols (`normalized_product_name`, `family`, `family_code`, `source`, `line`, `normalized_line`, `source_file`, `source_sheet`) — normally seeded from uploads; 3 confidential Head-Office products (LA003/LA004/SS001, see [[la003-la004-confidential-products]]) plus an `IGNORE` sentinel row have no marketing counterpart by design.

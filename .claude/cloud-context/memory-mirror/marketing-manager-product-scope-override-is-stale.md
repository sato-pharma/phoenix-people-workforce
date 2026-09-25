---
name: marketing-manager-product-scope-override-is-stale
description: "A-9's product_scope_override must be topped up at EVERY product launch on her 3 lines — it is a hard row filter AND the second guard keeping the Head Office product RY001 (which sells) out of her view; topped up to 23 codes 2026-08-12"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4e357fcd-e1c3-4d36-9cbd-76fac613547c
  modified: 2026-08-12T16:38:31.745Z
---

`app_auth_users` row **A-9** (Hossam Mohamed Reda AboElftouh, Marketing Manager) carries, verified
live 2026-08-12:

- `sales_scope_override = 'COMPANY'` → in `computeSalesAccessScope` this returns early with
  **`allowedLineNames: null`, i.e. EVERY line**. Her line bound is not the oversight set.
- `line_scope_override = ['Pedia','CNS','Anti infective']` (note the lower-case "infective")
- `product_scope_override` = **23 product codes** (was 21; TE006 + TE007 added 2026-08-12)
- `employees.line_name` is **NULL**; `region_name` is `'Head office'`

## Two jobs, and the second one is easy to miss

**1. It must cover every product on her three lines**, or her Monthly Closing workbook stops tying.
It is a hard row filter (`applyProductCodeAllowlist` inside `resolveSalesAccessScope`), and the
closing export's full-workbook branch draws its Matrix sheet from the **unscoped**
`loadMonthlyClosingParts` while its Data/Total audit pair comes from the **scoped**
`loadMonthlyClosingDetails`. A product she lacks shows a Matrix column with no matching Data rows —
**silently, on HTTP 200**. It was 2 SKUs short (TE006 Tebofortin Intens, TE007 Tebofortin Max) until
2026-08-12. Now 100% covered: Anti Infective 2/2, CNS 17/17, Pedia 4/4.

**2. It is the SECOND guard keeping Head Office products out of her view.** Because her line scope
is COMPANY (= all lines), the only other thing between her and the confidential Head Office line is
the `stripHeadOfficeRows` / `canViewHeadOfficeLine` strip — which **passes through rows carrying no
line dimension** (brick/customer aggregates). Of Head Office's 4 active products, LA003/LA004/SS001
are independently covered by `RESTRICTED_PRODUCT_CODES`, but **RY001 (ROYANOXICAM 8MG 20 TAB) is
NOT restricted and it SELLS — 217 rows, 10,458 EGP, 2026-01 to 2026-07.** Her list excludes all 4.

**This is why the override was NOT cleared.** The obvious fix for job 1 ("she oversees whole lines,
so a per-product allowlist does not describe her — clear it") would have removed the job-2 guard.
The owner chose to top it up to 23 instead, 2026-08-12. See [[restricted-skus-are-all-head-office-line]].

**How to apply:** whenever a product launches on Anti Infective / Pedia / CNS, **add its code to
A-9's `product_scope_override`** or her closing workbook silently stops tying. Check with: count
active `source_of_sales_products` per line against `unnest(product_scope_override)` for `login_id =
'A-9'`. Never set it to `[]` — `getUserProductScopeOverride` returns `Array.isArray(raw) ? raw :
null`, so **NULL = no restriction and `[]` = SEES NOTHING**. The risk is recorded in a comment at
the `detailsPromise` call in `app/api/sales/monthly-closing/export/route.ts` (that comment still
says 21 codes / TE006 + TE007 missing — stale as of the 2026-08-12 top-up).
Related: [[portal-closing-export-is-publication-gated]], [[marketing-manager-monthly-closing-tab]].

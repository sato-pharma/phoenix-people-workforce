---
name: direct-sales-area-code-is-empty-string-not-null
description: "Direct sales rows carry area_code = '' (empty string), never NULL — an `is null` predicate silently routes 100% of direct money the wrong way"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8021afd9-3043-4e4b-89ea-65e9119ba57d
  modified: 2026-08-03T21:26:11.483Z
---

Every DIRECT sales row in `source_of_sales_fact_rollup` and `source_of_sales_import_rows` has
`area_code = ''` — **the empty string, not NULL**. Measured on production
`ozucdzovmcqvepbozvqf` 2026-08-03 across all validated batches 2026-01..2026-07:

```
683 direct import rows: area_code IS NULL = 0, btrim(coalesce(area_code,'')) = '' → 683
175 direct rollup rows: brick_id blank 175/175, client_code NULL 175/175, region_code populated 175/175
```

**Why it bites.** The natural way to split "direct that has an area" from "direct that has none" is
`where area_code is null` / `is not null`. That predicate matches **zero** rows and **all** rows
respectively — the exact inverse of the intent. 100% of direct money lands in the "has an area"
bucket, grouped under a synthetic area whose code is `''`, which then fails to join
`source_of_sales_areas` and renders as a nameless blank row inside a region.

**Always write** `nullif(btrim(f.area_code), '') is null` (or `is not null`). The one correct
precedent already in the repo is `au.f_monthly_attribution`, which normalises exactly that way
before its crosswalk join. The closing RPCs (`phx_monthly_closing_matrix`,
`phx_monthly_closing_direct`) have **no such guard**.

**Related trap — the two closing RPCs are a matched disjoint pair.** `phx_monthly_closing_matrix`
filters `and not f.is_direct` and values rows at `effective_units × factory_price`;
`phx_monthly_closing_direct` filters `and f.is_direct` and values them at `sum(direct_value)`.
`injectDirectIntoMatrix` then **adds** the second onto the first. Relaxing the `not f.is_direct`
predicate to "merge direct into area rows" therefore counts direct **twice** — measured for
2026-07: 660,105.00 + 628,267.65 = **1,288,372.65** where 628,267.65 is correct. If direct must
reach area rows, change `phx_monthly_closing_direct` (add `area_code` to its grouping) and the
injector — never the matrix RPC's predicate.

**Also:** the string `'NATIONAL'` appears nowhere in either table, so `matrix.directNational` and
`matrix.companyTotal` are **always null in production**. Every code path reading them
(export rows, portal scoping, filtered rebuild) has never executed against real data — treat it as
unproven if you ever make it reachable.

Related: [[sales-sheet-rep-mapping-join-paths]] · [[sos-client-code-is-not-unique-across-distributors]]

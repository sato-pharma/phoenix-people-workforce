---
name: head-office-line-leak-is-ry001-not-212m
description: "The Head Office SoS line is 212.5M but 99.995% of it is ALREADY hidden by the restricted-product lock — the real leak was one product, RY001"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73e17b1a-b911-4f54-91a1-e54eb3d313b0
  modified: 2026-08-02T01:08:44.717Z
---

Measured in production (`ozucdzovmcqvepbozvqf`) on 2026-08-02, all validated batches:

| line | value | share |
| --- | --- | --- |
| Head Office | 212,549,244.12 | 78.2% |
| CNS | 39,422,977.80 | 14.5% |
| Pedia | 14,485,827.13 | 5.3% |
| Anti Infective | 5,211,528.71 | 1.9% |

**The 78% framing is true of the line, but NOT of what any leak actually exposes.** The Head Office
line holds exactly **4 products**, and three of them — `LA003`, `LA004`, `SS001` — are already in
`RESTRICTED_PRODUCT_CODES`, hidden independently for every non-CEO/Super-Admin role. The fourth,
**`RY001` (ROYANOXICAM 8MG 20 TAB), is not restricted** — 11,046.00 EGP all-time, 630.00 in 2026-06.

So when the confidential Head Office line leaked to the SFE Manager through
`loadSourceOfSalesDashboard`, the visible damage was a "Head Office" row worth **630 EGP**, not
212.5M. Say that number, not the 78%, when reporting this class of bug.

**Why the fix still mattered:** the containment was an accident of data, not a guard. Nothing stops a
fifth product landing on that line tomorrow, and the moment one does the exposure is unbounded. The
lock now works at the LINE grain (`isHeadOfficeLine(row.officialLine)`), not by hoping the code list
covers the line. See [[sos-import-dashboard-head-office-line-lock]].

**Useful invariants confirmed the same day** (re-verify before relying on them):
- `source_of_sales_import_rows.official_line` is populated on every row and is the per-row line truth.
- Raw rows reconcile with the `group_type='product'` summaries to **0.00** across all 7 periods —
  which is what makes a sum-based reconciliation guard safe rather than spuriously trippy.
- No Head Office row has a blank `product_code`; no product code appears on two lines.
- `analytics.sos_fact_all` also carries `line` + `region_name`, but it is **period**-keyed while the
  import dashboard is **batch**-keyed (validated batches only) — using it for the geo split would
  disagree with byLine/byProduct. Prefer `source_of_sales_import_rows`.

Related: [[sos-analytics-excludes-confidential-5x-gap]] · [[app-visibility-is-application-scoped-not-rls]]

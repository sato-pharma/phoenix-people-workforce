---
name: closing-matrix-inclusion-rule
description: "What phx_monthly_closing_matrix actually counts — only Direct and confidential products are excluded, NOT rows missing a client code"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 742e83f7-58dc-4dcf-883f-cf319a67cadc
  modified: 2026-07-29T07:42:26.894Z
---

`phx_monthly_closing_matrix(line, period)` counts **every** validated import row except two things:

1. `is_direct = true` (reported separately by `phx_monthly_closing_direct`)
2. product code in `LA003 / LA004 / SS001` (confidential)

**A missing `client_code` is NOT an exclusion.** The `where nullif(btrim(r.client_code),'') is not null` clause in the baseline migration belongs to the *customer-grain* rollup path, not the area/product grain the matrix reads. Assuming otherwise understated CNS 2026-06 by 11,205 units / 400,219.65 EGP.

Verified against production (`ozucdzovmcqvepbozvqf`) for 2026-06 — with exactly the two exclusions above, re-adding `source_of_sales_import_rows` reproduces the RPC to the cent:
Pedia 11,095u / 2,434,468.50 · Anti Infective 7,522u / 696,563.10 · CNS 66,656u / 4,109,041.65.

Row math: `units = sum(qty)` (raw, undiscounted); `value = sum(qty × (1 − discount)) × factory_price`. The `effective_units` column is the discounted base and is what gets priced — never price raw qty.

**Why:** the closing is the number the sales lines are judged on, so a wrong inclusion predicate silently moves millions of EGP.

**How to apply:** when adding any surface that claims to reconcile to the closing, re-run the tie-out in SQL against production before trusting a predicate read off a migration file. `tests/monthly-closing-details.test.ts` locks the rule in. As of 2026-06 zero rows have an unmapped brick or a brick-vs-sheet area mismatch, so brick-derived and sheet-derived area attribution currently agree. See [[ped-line-closing-workbook-s1-quarter-bug]] for the SFE-side equivalent.

---
name: the-ibn-sina-lacto-misr-export-is-a-second-supplier-feed-in-the-is-s-template
description: "Ibn Sina's `Weekly_Sales_And_Stock_For_LACTO_MISR_EG*.xlsx` is byte-identical in shape to the IS-S Sato feed but carries a DIFFERENT supplier's 4 Lacto SKUs — uploading it under IS-S makes the NEXT Sato week de-cumulate against a sheet with no Sato products and double-counts the month to date."
metadata:
  node_type: memory
  type: project
  originSessionId: 4fc4cc23-d36a-4eb9-90b2-febaa1978bd8
  modified: 2026-10-12T22:03:01.632Z
---

Ibn Sina exports one `SalesAndStockReport2_DataHub` workbook **per supplier**. Phoenix's `IS-S`
("Ibn Sina Sato") feed is `Weekly_Sales_and_Stock_For_SATO_PHARMA_(PAS)<ts>.xlsx`. On 11 Oct 2026 a
second one appeared — `Weekly_Sales_And_Stock_For_LACTO_MISR_EG20261011120032.xlsx`, supplier code
111399 — same sheet name, same 13 columns, same branch set, but only the four Lacto SKUs
(684793 `LACTO 1 400 GM`, 684794 `LACTO 2 400 GM`, 684795/684796 the `ADVANCED` pair). The two
files' products are fully disjoint: the IS-S October week-1 batch holds GU001, IV001, RO001, RY001,
SA001, SS001 and no Lacto; Ibn Sina has never filed a Lacto row in Phoenix.

🔴 **Do not upload it under `IS-S`.** `decumulateRows` groups by `(distributor, cycle_month)` and
subtracts the **previous `week_start`'s** `(product × branch)` cell. A Lacto sheet dated later than
the Sato sheet becomes that group's latest week while carrying none of the Sato cells — so the next
real Sato file subtracts **zero** instead of its predecessor's month-to-date and books the whole
cumulative month as one week. The Lacto rows themselves land fine; the damage is to the Sato
products, one week later, silently. A separate distributor code is what isolates the group — and a
new code needs its own 46 `weekly_sales_branch_region_map` rows and 4 `weekly_sales_product_aliases`
(both tables are keyed by `distributor_code`, so `IS-S`'s do not carry over).

Reading the file itself: header row 2, data row 3+, a grand-total row at the bottom with blank
Date/Item/Branch (the adapter already skips it). `adaptISS` reads only columns 1, 4, 5, 6, 7, 8 and
10 — **Stock Value, Free Unit, Sales Value and Total Sales are never read**, so the file's own
1,734,759 EGP is discarded and Phoenix re-prices units at master factory price (1,610,860.50 EGP,
-7.1%). "Total Sales" is a trap: it repeats Sales Quantity in units, not money. Stock Value is the
distributor's cost at 93% of its selling price — for Lacto Basic that is exactly the master's
`factory_price` 209.25, which is what confirms plain `LACTO 1/2 400 GM` → `LA003`/`LA004`
(Head Office) and the `ADVANCED` pair → `LA001`/`LA002` (Pedia).

By the [[head-office-products-are-not-tracked-weekly-golden-rule]], **93% of this file is out of
scope**: 7,186 Basic units are Head Office, and only 397 Advanced units reach a tracked line (Pedia).
Lacto already arrives weekly through PS (Overseas) and Direct, never through Ibn Sina — see
[[lacto-advanced-and-basic-share-family-and-family-code]].

Related: [[weekly-sales-decumulation-plan]], [[weekly-sales-has-no-area-grain]].

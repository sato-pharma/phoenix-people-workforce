---
name: el-qema-sept-export-blanks-both-account-id-and-product-code
description: "El Qema's Sept 2026 export blanked ACCOUNT_ID AND product code — the import needs name-keyed customer_map AND name-keyed product aliases, not just the customerKeyNameFallback code fix"
metadata:
  node_type: memory
  type: project
  originSessionId: 0c2df8ab-5d7e-4afc-9a08-0c5db6124df3
  modified: 2026-10-05T18:47:58.536Z
---

El Qema (distributor `QM`, Pedia-only) exports normally carry `ACCOUNT_ID` (customer code) and `رقم الصنف` (product code). The **September 2026** file (`exclusive - El Qema9.xlsx`) left **both columns blank** — headers present, cells empty — so the engine skipped every row as a footer and "read nothing".

Two independent things are needed, not one:
1. **Customer side** — `customerKeyNameFallback: true` on the QM profile makes the engine key the customer by the name cell (`الاسم`) when the code is blank. Shipped in **#5344** (merged/live 2026-10-05), with `tests/normalizer-qema-name-fallback.test.ts`.
2. **Product side (easy to miss)** — the QM profile's `productColumns` are `["رقم الصنف","الصنف"]`; with the code blank, `resolveProduct` is NAME-FIRST and tries `الصنف` = the Arabic string e.g. `لاكتو لبن 1 ادفانس*** باكو 12 س330ج`. The master product names are **English** (`Lacto Advanced 1/2`) and the only QM aliases were **numeric** (`5754`→LA001, `743`→LA002), so the Arabic name matched nothing → **zero rows import even with customers mapped.** Fix = add QM `source_of_sales_product_aliases` rows for the exact Arabic strings → LA001/LA002 (applied 2026-10-05, `source_file='el-qema-sept-2026-owner-review'`). These persist, so future months with the same product strings resolve automatically.

Mappings applied 2026-10-05 (owner-reviewed): **44** name-keyed `source_of_sales_customer_map` QM rows (`source='el-qema-sept-2026-owner-review'`, additive — the 30 numeric August rows untouched), confidence 100 for the 9 owner-decided names, 95 for the 35 derived from his August placements / city-in-name. Held unmapped: `البكس تيوتكس`, `شمعة القرن نيو` (no region — "no preference"). `مرتجعات الصعيد` is a **returns line, +12 in the file**; owner chose "credit to Upper Egypt" but the crosswalk only assigns a brick (can't negate a +12 into a −12), so it was left out of the import and the −12 UE credit is a separate closing adjustment.

El Qema's downstream sales still redistribute by the LOCKED three-band city/warehouse split (`store-sales-city-split.ts`) — so for QM the **region** matters, not the exact brick; never touch that split. See [[sos-monthly-closing-is-the-only-sales-truth]].

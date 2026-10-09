---
name: the-roi-exact-attribution-chain-joins-on-distributor-name
description: "ROI exact attribution reaches Source of Sales through the distributor's normalized NAME, never its code — marketing_distributors.distributor_code is a DST_* id that matches nothing in the rollup, so \"rollup_rows = 0\" is a false alarm; and request-geo facts come from attributed SALES, not from the pharmacy link graph"
metadata:
  node_type: memory
  type: project
  originSessionId: fdc61139-f675-4568-a97b-58356ad4027f
  modified: 2026-10-09T01:27:59.085Z
---

Three separate things mislead a session reading Marketing ROI attribution. All three were hit on
2026-10-09 while seeding staging.

**1. The chain joins on the normalized NAME.** `phx_refresh_marketing_roi_facts`'s
`req_targets_all` goes:

```
marketing_distributors md.normalized_name
  → marketing_roi_distributor_rollup.marketing_normalized_name
  → .parent_distributor_code                     -- the SHORT code: IS, PS, EP, EG, SF, RM, CP, MC
  → source_of_sales_distributors sd.distributor_code
```

and `sd.distributor_code` is what `exact_hits` then matches against
`marketing_roi_distributor_rollup.sos_distributor_code` (`IS` → `IS`, `IS-S`, `IS-T`; `PS` → `PS`,
`PS-T`) and finally `source_of_sales_import_rows.distributor_code`.

🔴 **So checking `parent_distributor_code = marketing_distributors.distributor_code` answers 0 on
BOTH environments and proves nothing.** That column holds a synthetic id —
`DST_IBN_SINA_9DBF268F`, `DST_POS_1478C028`, `SOS_IS-T` — which appears nowhere in the rollup. On
production every one of the 22 marketing distributors reads `rollup_rows: 0` while 24 sales rows
attribute perfectly, all `exact`. The live mapping is by name: `ibn sina → IS`,
`overseas → PS` (note POS's normalized name is **`overseas`**, not `pos`).

**2. `marketing_roi_request_geo_facts` is built from `actuals_by_request_geo` ← `all_hits`** — the
attributed SALES rows, grouped by request × `distributor_code` × `region_code`. It is **not** built
from `marketing_request_pharmacies`. So `requestGeo: 0` never means the pharmacy/distributor link
graph is missing; it means no sales row attributed. Staging had 29 request-pharmacy rows, 331
distributor codes and 326 pharmacies and still built zero, because its validated Source-of-Sales
data stopped at **2026-07** while every marketing request pays from 2026-08 on — which is correct
`awaiting_data` behaviour, not a defect. Seeding five matching `source_of_sales_import_rows` in a
`status = 'validated'` batch took it to 6 geo facts across 2 distributors and 2 regions.

**3. The attributed value is the PHOENIX price, not the distributor's own `value` column.** Rows
seeded with `value` 36,000 + 24,000 attributed as **6,480** for 200 units — `exact_hits` computes
`sales_value` from qty × the Phoenix price for that product and period, falling back to the row's
value only when that is missing. Consistent with
[[a-price-fix-silently-restates-every-published-closing]]. And the summary **de-duplicates a sales
row shared by several requests**: one PS row showed on three requests' own lines (3,037.50 each)
while the summary total counted it once — 20,632.50, not 26,707.50. A per-request sum that exceeds
the summary is therefore correct, never a double-count bug.

**How to apply:** to make a request attribute, match the tuple `sd.distributor_code` (short),
`mpdc.normalized_pharmacy_code` as `client_code`, and a product code present in
`source_of_sales_products`, in an `invoice_period` inside the request's window, with
`validation_state = 'valid'` on a batch whose `status = 'validated'`. Never diagnose the chain from
the distributor code column.

---
name: owner-sheet-vocabulary-stores-is-office-upa-is-a-channel
description: "In the owner's manual closing workbook \"Stores\" means the Office distributor and \"UPA\" means the EG-HOS/SF-T institutional channel — neither means what the words suggest, and getting this wrong makes his sheet look incomparable to Phoenix"
metadata: 
  node_type: memory
  type: reference
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T11:46:06.462Z
---

Decoded 2026-08-10 from `Jul- 2026 Sales Closing ( CNS Line ) Final .xlsx`. Both terms are
channels, not what they sound like. Without this the two sheets look impossible to reconcile.

| His word | What it actually is | Proof |
| --- | --- | --- |
| **"Stores"** | the **`Office` distributor** — rows with **no `client_code`** | July CNS: his Stores 42,838 = Phoenix `Office` 42,838, exactly |
| **"Retail"** | the 13 real distributors | his 62,315 vs Phoenix 62,102 (the −213 unit gap) |
| **"UPA"** | the **EG-HOS + SF-T institutional channel**, NOT a different pack | his Rispadex UPA 4,545 = EG-HOS 4,524 + SF-T 21, exactly |

**"Stores" is NOT `isStoreCustomer`.** The wholesaler city split
([[store-sales-split-evenly-across-city-areas]]) acts on customer NAMES; his Stores column is the
Office channel and has no customers at all. Two unrelated things.

**"UPA" is a channel, not a SKU.** Phoenix's RI001/DO001 are pack codes resolved from aliases, so
RI001 sat empty while his sheet showed 4,545. Fixed 2026-08-10 by re-pointing five per-distributor
aliases (EG-HOS `10409` / `Rispadex 3 mg` / `RISPADEX FILM C.TABS 3 MG 30`, SF-T `Rispadex 3 mg` /
`RISPADEX  3 MG. 30 TAB(T)`) to **RI001**, then re-stamping 135 rows / 15,935 units across Jan–Jul.
Note **Dopaminect UPA is different** — it maps to the TENDER files (PS-T + RM-T), not EG-HOS. So
"UPA" resolves per product, not by one rule.

**His sheet's per-area figures are already post-distribution.** The `Total` tab's Stores column is
the Office spread already applied (whole numbers); the `Formula` / month tabs are the same thing
fractional. There is no pre-split view in his workbook.

**Known errors in HIS sheet** (he confirmed both): the EZ wholesaler `مخزن شركه اى زد` (1011654,
2,650 units) is booked to Heliopolis but belongs to **Nasr City** — its brick `B205-4` is literally
named مدينة نصر, and his own weight tab has it in Nasr City; he moved it afterwards. And his units
need nine corrections to reach Phoenix's 104,940: −212 Dopaminect UPA (double count), move 22
Conviban 25→50, −9 Tebofotin drops, +9 Conviban 100, plus four ≤3-unit items.

See also [[owner-office-allocation-rule-value-share]], [[closing-uses-total-qty-not-effective-units]].

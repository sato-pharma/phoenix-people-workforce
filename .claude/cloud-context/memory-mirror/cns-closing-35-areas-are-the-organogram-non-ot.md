---
name: cns-closing-35-areas-are-the-organogram-non-ot
description: "The CNS closing shows 35 area rows in 6 regions — exactly the areas whose au.line_area_map operational region is not the OT catch-all; Down town sits in Giza and Kafr El-Sheikh 1 in Alex-BHR, which contradicts the geography table"
metadata: 
  node_type: memory
  type: reference
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T11:46:38.992Z
---

Confirmed 2026-08-10 against `au.line_area_map` for `line_code='cns'` after the owner pasted his
closing's area list. His list matched the organogram **exactly**, including the two rows that look
wrong against `source_of_sales_areas.region_code`.

| Region | Areas |
| --- | --- |
| **Cairo** | CA1 Heliopolis · CA2 Nasr City · CA3 Cairo East 1 · CA4 Cairo East 2 · CA6 Cairo West |
| **Giza** | **CA5 Down town** · GZ1 · GZ2 · GZ4 · GZ5 · GZ7 |
| **Upper Egypt** | UE1 · UE2 · UE3 Assuit 1 · UE4 Assuit 2 · UE5 Sohag1 · UE6 Sohag2 · UE7 Qena 1 |
| **Alex-BHR** | AB1 · AB2 · AB3 · AB4 · AB5 · **D16 Kafr El-Sheikh 1** |
| **Delta (1)** | D11 Qalubeya · D12 · D13 · D14 Gharbia 1 (Tanta) · D15 Gharbia 2 (Mahalla) |
| **Delta (2)** | D21 · D22 · D23 · D24 · D25 · D26 Port said - Domiat |

**Down town is CA5 but belongs to GZ on CNS. Kafr El-Sheikh 1 is D16 but belongs to AB.** Both come
from the organogram, not the geography table — do not "correct" them.

**The other 14 areas are the OT catch-all** and do not appear as closing rows: D17 Kafr El-Sheikh 2,
GZ3 Imbaba, GZ6 Fayoum, UE8 Qena 2, UE9 Beni Suef, OT1–OT10. July CNS holds **8,748 units** there,
so any comparison restricted to the 35 must state the OT residual or the totals will not reconcile
(owner's sheet puts 10,519 in its equivalent bucket).

The owner's sheet also carries an area called **«Main Store»** (1,543 units July CNS) that has no
Phoenix equivalent — still unresolved; do not silently map it to the leftover OT areas.

Separately, `CLOSING_AREA_MERGES` defines exactly **one** merge — `GZ6 + UE9` → "Fayoum - Beni Suef"
for pedia and cns only. Claims that the closing also merges Luxor+Aswan or Ismailia+Suez are wrong;
those are merges in the owner's own workbook. See [[fayoum-beni-suef-golden-rule-per-line]].

---
name: ivyronc-military-price-is-14-main-store-only
description: "Ivyronc (IV001) is 30.375 everywhere EXCEPT the military \"Main Store\" depot line, which is 14 — units count normally, only value differs"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e908adcc-abd2-4e16-9fb1-92d5cb0eeff1
  modified: 2026-08-14T19:17:10.415Z
---

Owner rule, stated 2026-08-14: **"in military exception ivy is 14 but in military only."**

Ivyronc (IV001) factory price is **30.375** across all normal channels. The **one exception** is the
military depot — the manual labels it `Others / Main Store / Discount`, the Arabic client is
**المستودع الطبى الرئيسى** ("Main Medical Depot"). That line is priced at **14**, and 14 applies
**only** to it. In the Feb-2026 Pedia manual this was a single **20,000-unit** line = value 280,000;
every other Ivyronc unit (7,476) was 30.375.

**This is a VALUE rule, not a units rule.** The 20,000 military units still COUNT in the closing
(Feb Pedia total IV = 27,476 = 20,000 military + 7,476 regular). The owner's per-product/per-channel
UNITS pass test is unaffected by the price. Only the sales *value* changes: manual IV value =
20,000×14 + 7,476×30.375 = 507,083.5, not 27,476×30.375.

**How it was applied (Feb Pedia, 2026-08-14):** the 20,000-unit depot order was reclassed PS→Direct
(it was mis-booked under PS as rn 23342), then the Direct IV recon row was **split** into a military
row (20,000 @ 14 = 280,000, `raw_row.kind='ped-direct-military'`, `unit_price=14`) plus a regular
Direct row (935 @ 30.375). This made Phoenix's stored Direct-IV value match the manual's
military-priced total. The closing matrix still recomputes non-direct value at the flat 30.375
(Direct is excluded from the matrix), so the 14 only lives in the stored Direct rows.

Feeds the factory-price audit (task #6) and applies to **every** closing that carries a Main
Store / military Ivyronc line. See [[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]]
and [[july-cns-office-override-and-main-store-bucket]].

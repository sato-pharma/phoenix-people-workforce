---
name: epda-reuses-one-client-code-for-two-pharmacies
description: "EP-PHS reuses a single client_code for two different pharmacies in different cities — 43 codes in July 2026 — and in 42 of them both are booked to the SAME brick, so one is always in the wrong area; customer_map cannot represent this"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T11:46:57.736Z
---

Found 2026-08-10 while trying to apply an owner brick ruling that would have moved a Tanta pharmacy
to Alexandria.

July 2026, `source_of_sales_import_rows` grouped by (distributor, client_code):

| | |
| --- | --- |
| Codes carrying **two different `client_name`s** | **43** |
| Units affected | **455** |
| Codes where **both** pharmacies sit on the **same brick** | **42 of 43** |
| Distributor | **EP-PHS only** |

Examples — the two are in different governorates:

- `22199255` = «محمد مسعد فرحات - المحله» **and** «محمود محمد برمو - السيوف» (Mahalla / Alexandria)
- `22197863` = «ايمان جمال - بولاق الدكرور» **and** «بدر احمد مرسى - حلوان»
- `22199672` = «احمد فتحى احمد - طنطا» (B193-1 طنطا, D14) **and** «يحيى - العامريه» (B152-2 العامرية, AB3)

**Why it is invisible:** the totals always balance, and 42 of 43 share one brick, so the area report
looks complete while one pharmacy of each pair is in the wrong area.

**Why it blocks the ruling machinery:** `source_of_sales_customer_map` is keyed on
(customer_code, distributor_code), so it structurally **cannot** hold two answers for one code.
Applying a ruling to such a code necessarily misplaces the other pharmacy. `22199672` was therefore
excluded from the 2026-08-10 bulk re-stamp and left on its invoice brick.

**Detect it:**

```sql
select distributor_code, client_code, count(distinct client_name), count(distinct brick_id), sum(qty)
from source_of_sales_import_rows
where invoice_period = '2026-07' and coalesce(btrim(client_code),'') <> ''
group by 1,2 having count(distinct client_name) > 1;
```

Owner decision still open (asked 2026-08-10): book each row by its own invoice brick and ignore
customer_map for these codes, vs ask EPDA to re-issue unique codes.

Related: [[owner-ruling-canary-misses-source-manual]], [[sos-duplicate-brick-names-are-decoys]].

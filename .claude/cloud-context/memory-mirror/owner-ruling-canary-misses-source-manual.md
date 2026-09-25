---
name: owner-ruling-canary-misses-source-manual
description: "The \"owner rulings reverted\" integrity check filters source like 'owner-ruling%' but almost every real ruling is source='manual', so it reports 0 while 1,364 July units sit on the wrong brick"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T08:21:14.422Z
---

The canary in the 2026-08-10 handover and work order:

```sql
... where r.invoice_period='2026-07' and m.source like 'owner-ruling%' and r.brick_id <> m.brick_id
```

It returns **0**. Drop the `source` filter and July 2026 returns **35 customers / 1,364 units**
booked against their stored `source_of_sales_customer_map` ruling — CNS 22 customers / 1,291 units,
Anti Infective 18 / 46, Head Office 4 / 23 (+4 on `sheet-verified`). Only a handful of rows ever
carry the `owner-ruling%` prefix; the rest were written with **`source='manual'`**, so the guard
watches the wrong column value and reads clean while the data is wrong.

**Always run it without the `source` filter.**

**The worked example** (the whole Sohag swing in the July CNS closing, measured 2026-08-10):
customer `434921 الصيادلة فارم` is ruled to brick `B166-1` / area `UE6` (Sohag2), `source='manual'`,
set 2026-08-06 14:35 Cairo.

| distributor | row brick | row area | ruled | units |
| --- | --- | --- | --- | --- |
| **IS** | `B213-1` | **UE5** Sohag1 | `B166-1` UE6 | **931** ← reverted |
| IS-S | `B166-1` | UE6 Sohag2 | `B166-1` UE6 | 220 ← intact |

Ibn Sina (`IS`) was re-imported and `resolveBrick` re-stamped its rows from the distributor sheet,
which outranks the stored mapping; `IS-S` was not re-imported and kept the ruling. **The same
customer is therefore split across two areas by import history alone.**

It then reaches the closing because `phx_monthly_closing_matrix` groups by
`source_of_sales_fact_rollup.area_code` — the row's own area — so a ruling that lives only in
`customer_map` never moves a closing figure. Repairing it means re-stamping all three tables
(`source_of_sales_import_rows`, `source_of_sales_fact_rollup`,
`source_of_sales_customer_directory_rollup`), not just `customer_map`.

See also [[closing-detail-areacode-is-brick-not-fact-area]],
[[moving-a-sos-brick-between-areas-needs-four-restamps]],
[[sos-duplicate-brick-names-are-decoys]].

---

## 2026-09-04 — the mirror image, and it is the commoner one

August 2026 is the same split seen from the other side, and it is **worse** because the whole month
tilts at once rather than one customer.

**`IS` had ZERO import rows in August** (July had 7,237). Only **`IS-S`** was loaded, on 2026-09-02 —
and **353 `IS-S` map rows were created that same day** by `a-2` as generic `sheet-verified`, resolving
to coarse CITY bricks (`مدينة سوهاج`, `مدينة أسيوط`, `مدينة قنا`, `منيل الروضة`). The owner's rulings
sit on the **`IS`** rows. So **every ruling he had made was silently ignored by the August closing** —
no error, no marker, just a plausible number on the wrong area.

Scale: **2,975 customers hold both an `IS` and an `IS-S` row; 174 disagree on area; 55 had August
sales; 26 of those carried an owner ruling on the `IS` side.**

**The diagnosis rule: when a month's areas look wrong wholesale, first ask which distributor codes
actually loaded that month.** A missing `IS` reads exactly like a mapping regression.

**Repaired 2026-09-04** — 41 customers re-stamped (28 restored to their `IS` rulings, 1 in `PS`,
12 resolved from the town the distributor itself wrote). Pre-images:
`sos_backup_20260904.import_rows_pre` / `.customer_map_pre` / `.owner_ruling_targets` (the 28),
`.import_rows_pre2` / `.customer_map_pre2`, `.import_rows_pre3` / `.customer_map_pre3`.

### Deciding a disputed area from the distributor file

Ibnsina's `Territory Name` is `<TERRITORY> <roman> <BRICK>`. **The roman numeral is IBNSINA's own
district and does NOT equal a Sato area number** — `KAFR ELSHEIKH I ELHAMOUL` resolved to
Kafr El-Sheikh **2**. **Decide by matching the town in the `Governorate Name` / `Address_En` field
against `source_of_sales_bricks`, never by the numeral**, and never by the `Brick Name` field, which
is a two-district RANGE (`FOHA - MOTOBAS`, `EL MATARIA - AIN SHAMS`) and is what produced the coarse
city bricks in the first place.

**Two city bricks are deliberately SPLIT across both of their areas, so no address can settle them:**
`مدينة قنا` is `B209-1` (UE7 Qena 1) **and** `B209B-1` "مدينة قنا - قنا 2" (UE8 Qena 2). Check for a
`<city> - <area> 2` twin before ruling on any city-centre customer. Sohag city (`B213-1`) is **not**
split — it is UE5 only.

An area re-stamp is a **transfer between areas**: the line total does not move. Anti Infective August
read 4,811 units / 442,520.05 EGP before and after all 41 moves.

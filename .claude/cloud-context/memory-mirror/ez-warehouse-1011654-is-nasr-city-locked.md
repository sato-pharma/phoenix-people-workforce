---
name: ez-warehouse-1011654-is-nasr-city-locked
description: "EZ (مخزن شركة اى زد, customer 1011654) is NO LONGER a single area — since 2026-08-26 (golden lock 2026-09-06) its CNS sales are credited EVENLY across the CNS reps active in Cairo+Giza that month. The old Nasr City ruling and his files' Heliopolis label are history; it is the largest CNS customer and drives the value-weighted Office spread"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-10-02T16:34:36.060Z
---

**Customer `1011654` — «مخزن شركه اى زد لاداره وتطوير المشروعات الدوائيه EZ»** is a pharmaceutical
warehouse buying through **RAMCO**, registered at *مخزن رقم 2، قطعة 95، منطقة المخازن والمستودعات،
شمال طريق القطامية – العين السخنة* — the Katameya/Sokhna industrial storage zone, which is neither
Nasr City nor Heliopolis. It has no natural area; it belongs wherever its rep sits.

**CURRENT RULE (owner ruling 2026-08-26, made a GOLDEN LOCK 2026-09-06): EZ is CNS-only and its
sales are credited EVENLY across the CNS reps active in Cairo and Giza that month**, from a roster
frozen per period, applied on read by `phx_sos_rows_attributed(period)` — never in the fact rollup.
It is not credited to any single area. Full rule, its four locked surfaces and the freeze trap:
[[ez-is-credited-evenly-across-cairo-giza-cns-reps]].
**Superseded 2026-10-02:** previously "OWNER RULING 2026-08-10/11: NASR CITY", stamped in
`source_of_sales_customer_map` as `source = 'owner-ruling-ez-warehouse-is-nasr-city-2026-08-11'`,
`confidence = 100` — replaced by the even-split ruling of 2026-08-26 / golden lock of 2026-09-06.

**Why this one matters more than its size:** it is the biggest CNS customer in the country
(Jul 2,650 units / 278,764 EGP; Jun 3,846; Feb 2,410 — it swings hard month to month), and the Office
spread is **value-weighted**, so whichever area holds EZ also draws a much larger share of the 42,838
Office units. Misplacing it costs **roughly twice its size — measured at 5,300 units on July CNS**,
the single largest item in the whole manual-vs-Phoenix reconciliation. See
[[owner-office-allocation-rule-value-share]] for the doubling mechanism. Under the even split,
`phx_office_brick_share` reads the attributed rows (each roster area on its own landing brick), so
EZ's weight in the Office spread is now shared across those Cairo+Giza areas rather than landing on
one.

**The trap: his own files keep saying Heliopolis.** His July retail sheet said Heliopolis while his
`STORE Calculation` weight tab said Nasr City — the same workbook, two answers. `Book3hh.xlsx`
(2026-08-11) also says Heliopolis. Since the even split, neither label decides EZ's rep credit — but
**still do not apply a bulk customer-area file to `1011654` without asking** — check for it by code
before every wholesale load, and hold it out the way the Book3hh load did; the EZ rule is a
behavioural golden lock with no CI guard.

Related: [[cns-2026-08-10-production-changes-applied]] ·
[[never-silent-drop-count-and-flag-instead]]

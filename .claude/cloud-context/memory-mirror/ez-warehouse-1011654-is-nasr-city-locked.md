---
name: ez-warehouse-1011654-is-nasr-city-locked
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: GOLDEN LOCK 2026-09-06 — EZ is credited EVENLY across the CNS reps active in Cairo+Giza that month ... Supersedes [[ez-warehouse-1011654-is-nasr-city-locked]] on the area question (see `ez-is-credited-evenly-across-cairo-giza-cns-reps`). Older text follows: EZ (مخزن شركة اى زد, customer 1011654) is NASR CITY by owner ruling — it is the single largest CNS customer, its placement error costs DOUBLE, and his own files keep saying Heliopolis"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-11T05:19:52.545Z
---

**Customer `1011654` — «مخزن شركه اى زد لاداره وتطوير المشروعات الدوائيه EZ»** is a pharmaceutical
warehouse buying through **RAMCO**, registered at *مخزن رقم 2، قطعة 95، منطقة المخازن والمستودعات،
شمال طريق القطامية – العين السخنة* — the Katameya/Sokhna industrial storage zone, which is neither
Nasr City nor Heliopolis. It has no natural area; it belongs wherever its rep sits.

**OWNER RULING, given 2026-08-10 and re-confirmed 2026-08-11: NASR CITY.** Now stamped in
`source_of_sales_customer_map` as `source = 'owner-ruling-ez-warehouse-is-nasr-city-2026-08-11'`,
`confidence = 100`, so a bulk re-map cannot quietly take it.

**Why this one matters more than its size:** it is the biggest CNS customer in the country
(Jul 2,650 units / 278,764 EGP; Jun 3,846; Feb 2,410 — it swings hard month to month), and the Office
spread is **value-weighted**, so whichever area holds EZ also draws a much larger share of the 42,838
Office units. Misplacing it costs **roughly twice its size — measured at 5,300 units on July CNS**,
the single largest item in the whole manual-vs-Phoenix reconciliation. See
[[owner-office-allocation-rule-value-share]] for the doubling mechanism.

**The trap: his own files keep saying Heliopolis.** His July retail sheet said Heliopolis while his
`STORE Calculation` weight tab said Nasr City — the same workbook, two answers. `Book3hh.xlsx`
(2026-08-11) also says Heliopolis. **Do not apply a bulk customer-area file to `1011654` without
asking** — check for it by code before every wholesale load, and hold it out the way the Book3hh
load did.

Related: [[cns-2026-08-10-production-changes-applied]] ·
[[never-silent-drop-count-and-flag-instead]]

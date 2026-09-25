---
name: placement-rulings-and-office-reimport-applied-2026-08-12
description: "APPLIED TO PROD 2026-08-12 — 36 customer placement rulings re-stamped across all 7 periods, all 37 map rows locked to confidence 100, and July CNS Office re-allocated; do not redo or undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: ff721f65-99c8-4ef2-92f2-305a08d0d465
  modified: 2026-08-12T07:42:23.478Z
---

**Applied to production 2026-08-12 from the owner's returned ruling sheet. Do not redo or undo.**

**1. Customer placement — 36 customers, his ruling, all periods.**
`customer_map` area/brick corrected on **7 rows (6 customers)**; `source_of_sales_import_rows`
re-stamped **212 rows**; `source_of_sales_fact_rollup` re-stamped **346 rows**; Jan–Jul, across CNS,
Pedia, Anti Infective and Head Office.

**The important discovery: 30 of the 36 needed NO mapping change.** `customer_map` already held the
owner's answer — the **fact rollup** was carrying a stale area, and
`phx_monthly_closing_matrix` reads `f.area_code` from the rollup and **never consults customer_map**.
So a placement fix is a ROLLUP re-stamp, not a mapping edit. Editing `customer_map` alone changes
the closing by exactly zero.

**2. All 37 map rows locked to `confidence = 100`** (27 were NULL). This is load-bearing:
`resolvers.ts` treats confidence=100 as absolute and able to move a sale across areas, but below
that *"the sheet wins and we keep the area"* — so the next distributor import would have silently
moved those 27 back. Algorithmic scores cap at 95, so nothing can override them now.

**3. July CNS Office re-allocated** via the real locked path (`commitOfficeAllocation` on his
`JUL-2026  office.xlsx`, 42,838 units). Office is imported LAST and its weights rebuild from the
rollup, so it HAD to be re-run after the placement change. Result: Heliopolis Office 575 → **3,461**
(now the largest), Nasr City 4,214 → **1,338** — the rule doubling the EZ move exactly as documented.

**Conservation proven at every step:** July CNS still **105,152 units / 8,066,152.47**, all seven
months unchanged in total. Placement moves credit between areas, never creates or destroys it.

**EZ warehouse 1011654 is now HELIOPOLIS (CA1)**, reversing the 2026-08-11 Nasr City ruling. The
owner was shown the conflict three times — his own confidence-100 ruling from that morning, and the
customer's own address (*"شمال طريق القطاميه العين السخنة"*, whose Katameya brick sits in CA2) — and
reaffirmed each time. Brick set to `B196-2` (ميدان هليوبوليس) as a neutral placeholder; no CA1 brick
matches that address. **Supersedes [[ez-warehouse-1011654-is-nasr-city-locked]].**

**Residual vs his sheet after all this:** 38 areas compared, total absolute error **5,632 units**, 28
areas within 100. Half the residual is CA1 +1,418 / CA2 −1,398 — and that is **his** side being
stale: his Office spread is 378 BAKED rows computed against an older retail state, so his Office
column has to be recomputed before the two can agree. Not a Phoenix defect.

**Backups**, all in private schemas with anon/authenticated revoked:
`placement_ruling_backup_20260812` (37 map / 467 rollup / 765 import rows) and
`office_reimport_backup_20260812` (1 batch / 3,627 rollup / 3,627 import rows).

**Also found, NOT fixed:** 239 fact-rollup rows whose brick belongs to a different area than the
row's `area_code` — all pre-existing on other customers, none from these 36.
See [[moving-a-sos-brick-between-areas-needs-four-restamps]].

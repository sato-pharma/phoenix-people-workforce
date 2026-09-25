---
name: closing-export-applies-a-store-split-the-frontend-does-not
description: "\"Frontend right, XLSX wrong\" on the closing = the export-only city store split; wholesaler sales are spread evenly across the city's areas, producing fractional units"
metadata:
  type: project
---

**"Frontend right, XLSX wrong" on the closing has TWO unrelated causes. Check which one first:**
totals match but areas differ → the store split (below). **Totals are SHORT → the portal export
dropped every direct sale** (fixed 2026-08-10, PR #2007). `buildPortalClosingWorkbook` rebuilds its
matrix from invoice rows via `rebuildMatrixFromRows`, whose first line is
`if (!row.includedInClosing) return` — and direct rows ALWAYS arrive `includedInClosing: false`.
Direct vanished from the Closing Matrix, Target vs Achievement and the headline, silently, because
the same call left `writeTotalSheet`'s `directInMatrix` at its zero default so the bridge line that
names the gap never printed and Difference still read zero. July exposure was 1,059,259.65 EGP
(Pedia) / 149,288.50 (Anti Infective). The fix is the opt-in `includeDirect` flag — **off by default
because the ADMIN row-level-filtered export is deliberately invoice-only**, so never "fix" that path
by turning it on. See [[july-direct-overlay-and-rollup-must-move-together]].

If the closing screen and the downloaded workbook disagree on **area** rows while the **line and
national totals match**, stop looking for stale data. The export applies a transformation the
frontend never runs: `prepareClosingStoreSplit` → `splitStoreSalesAcrossCityAreas`
(`src/lib/sales/store-sales-city-split.ts`).

The rule: a customer classed as a wholesaler (`isStoreCustomer`, name-based) has its sales taken out
of its own area and **divided evenly across every area of its city** (`AREA_CITY` / `CITY_AREAS`).

**The tell is fractional units.** `182.333333` / `-140.666667` = thirds, i.e. a three-area city.
Totals stay conserved, so only the area split looks wrong — which is exactly why it reads as
"nothing changed" rather than as a bug.

**Why it bit (2026-08-06):** the owner ruled client 441164 ريونيون's −34,380 July return splits 50/50
across Dakahlia 2 and Port Said – Domiat. The rows were split, the frontend was right — then the
export took the **whole** −34,380 back out of Dakahlia 1 (its `customer_map` area) and shared it
three ways across Dakahlia 1/2/3, giving a third of a return to an area with no part in it and
skipping Port Said entirely because it is a different **city**. Fixed by
[[july-anti-infective-reunion-split-exception]]'s companion PR #1861: a customer already split
across areas is never re-split.

**How to apply:** read the workbook's **Store Split** and **Store Split Detail** tabs first — they
name every store that moved, its own area, and how many ways it was shared. Faster than any query.
And read the owner's actual file from `C:\Users\satoh\Downloads` with openpyxl rather than asking him
to retype numbers. See also [[closing-retail-value-is-units-times-factory-price]].

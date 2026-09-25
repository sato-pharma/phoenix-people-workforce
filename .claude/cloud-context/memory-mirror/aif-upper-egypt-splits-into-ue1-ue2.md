---
name: aif-upper-egypt-splits-into-ue1-ue2
description: "Anti Infective runs Upper Egypt as TWO districts (UE-1/UE-2); the closing sheet now splits them — but GZ6 mixes Fayoum and Beni Suef and cannot be split yet"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6677a3d-7a55-4b80-ba05-1f72e90c0e42
  modified: 2026-08-02T13:09:24.755Z
---

**Owner ruling 2026-08-02:** the Monthly Closing sheet must show Anti Infective's Upper Egypt as
**two** district blocks, per the organogram:

- **UE-1 "Upper Egypt 1"** — UE1 Minia 1, UE2 Minia 2 · seat `SEAT-AIF-ADM-UE-1` (acting DM
  Nosiba Salah Hussenin Moussa, B-1)
- **UE-2 "Upper Egypt 2"** — UE3..UE8 Assuit 1/2, Sohag 1/2, Qena 1/2 · seat `SEAT-AIF-DM-UE-2`
  (DM Ahmed Nashaat Ali Ahmed, B-175)

Only Anti Infective splits. CNS and Pedia have one flat `UE` and must stay that way.

**The bug this fixed:** the grid grouped areas by `source_of_sales_areas.region_code` (flat `UE`)
while the Direct channel already imports `UE-1`/`UE-2`. So Anti Infective rendered Upper Egypt
**three times** — one distributor block plus two direct-only orphan blocks named by bare code —
and neither manager could read their own number.

## 🔴 GZ6 is a MIXED area — the owner's rule cannot be fully honoured yet

Owner's exact words: *"only in Anti Infective, Fayoum belongs to GZ and Beni Suef belongs to
UE-1; in other lines these areas belong to GZ."*

`GZ6 "Fayoum-Beni Suef"` is **one area spanning two governorates**, so this is a sub-area split
the data model cannot express. Its 16 bricks straddle both, and **block B191 itself is mixed**
(`مدينة الفيوم` + `طميه` are Fayoum; `الوسطى`, `مدينة بنى سويف`, `مركز ناصر`, `بيبا`, `سامستا` are
Beni Suef), so no block-level grouping separates them either. June 2026 Anti Infective: Beni Suef
**75u / 8,185.05 EGP** vs Fayoum **6u / 666.90** — i.e. ~92% of GZ6 is really UE-1's.

Note `au.line_area_map` says GZ6 -> `UE-1` for anti_infective and `SEAT-AIF-REP-GZ6` sits under
`SEAT-AIF-ADM-UE-1` — the organogram already assigns the WHOLE area to UE-1. **Shipped state:
GZ6 stays in Giza** (deliberately — see the refinement-only rule below). Real fix = split GZ6
into two areas in the master geography, then re-point `au.line_area_map` and the area-grain
targets. Not done. `بليفيا` (B127-66) was never classified either way.

## The rule the code uses — "refinement only"

`isClosingRegionRefinement` in `src/lib/sales/monthly-distributor-import.ts`: adopt
`au.line_area_map.operational_region_code` **only when it is the sheet region plus a suffix**
(`UE` -> `UE-1`). That single predicate matched exactly the 8 Anti Infective UE areas across all
three lines and nothing else, which is why it delivers the split without touching CNS/Pedia.

It deliberately IGNORES the same column's two other meanings — line-specific Others parking
(AIF CA5/D11/D17/D25/GZ7 -> `OT`) and neighbour-district ownership (GZ6 -> `UE-1`, CNS D16 ->
`AB`). Owner chose "keep this change surgical" on the Others question — **still open**, worth
~167u / 17,554.05 EGP of June AIF sitting in Cairo/Giza/Delta blocks whose DMs carry no target
for them (inflates their achievement %). See [[untargeted-area-taxonomy-and-closing-region-mismatch]].

## Traps

- **Region NAME scoping breaks on a split.** Both UE managers' `employees.region_name` is
  `"Upper Egypt"`, which matches neither `"Upper Egypt 1"` nor `"Upper Egypt 2"`.
  `MonthlyClosingRegionGroup.baseRegionName` exists so `scopeMatrixToRegionNames` still matches;
  removing it hands both managers a **blank** closing (proven by breaking it — the test's own
  assertion returned `[]`). DM/RM normally go through the area-code bound instead
  ([[app-visibility-is-application-scoped-not-rls]]).
- **Ambiguous `UE` Direct rows still exist** for AIF: 2026-05 130u, 2026-06 320u / 18,760.00,
  2026-07 400u / 33,334.00. They now surface as their own "Upper Egypt" direct-only block rather
  than being folded into a district. #1628 blocks NEW ones; the historical rows need re-tagging.
- `source_of_sales_regions` AND `au.regions` both already carry `UE-1`/`UE-2` rows — the split was
  in the reference data long before the closing sheet honoured it.

Related: [[closing-matrix-inclusion-rule]] (what the matrix counts),
[[sos-per-line-region-columns-are-geographic-not-routing]] (never overwrite
`operational_region_code` from the workbook).

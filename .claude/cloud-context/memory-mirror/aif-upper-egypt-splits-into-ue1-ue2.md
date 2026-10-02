---
name: aif-upper-egypt-splits-into-ue1-ue2
description: "Anti Infective runs Upper Egypt as TWO districts (UE-1/UE-2) and the closing sheet splits them by grouping on the organogram's operational_region_code (applyOperationalRegions) — isClosingRegionRefinement never existed. Pedia ALSO splits UE-1/UE-2 from 2026-09-01 with a DIFFERENT membership (August never) — never align the two lines. GZ6 is no longer mixed: Beni Suef was split out as its own area UE9 on 2026-08-03."
metadata: 
  node_type: memory
  type: project
  originSessionId: c6677a3d-7a55-4b80-ba05-1f72e90c0e42
  modified: 2026-10-02T16:32:44.171Z
---

**Owner ruling 2026-08-02:** the Monthly Closing sheet must show Anti Infective's Upper Egypt as
**two** district blocks, per the organogram:

- **UE-1 "Upper Egypt 1"** — UE1 Minia 1, UE2 Minia 2 · seat `SEAT-AIF-ADM-UE-1` (acting DM
  Nosiba Salah Hussenin Moussa, B-1)
- **UE-2 "Upper Egypt 2"** — UE3..UE8 Assuit 1/2, Sohag 1/2, Qena 1/2 · seat `SEAT-AIF-DM-UE-2`
  (DM Ahmed Nashaat Ali Ahmed, B-175)

**Pedia splits too, from 2026-09-01 — and August NEVER contains the split** (THE AUGUST / UPPER
EGYPT GOLDEN RULE, sales-closing module rule, pinned by `tests/pedia-upper-egypt-split.test.ts`).
Pedia's **UE-1** is Fayoum, Beni Suef, Minia 1-2, Assuit 1-2; its **UE-2** is Sohag 1-2, Qena 1,
Qena 2 and Luxor (not a separate area — it rides in as `other_permanent` with no rep seat). That
membership DIFFERS from Anti Infective's above (Assuit is UE-2 on AIF, Fayoum is Giza) — never
"align" the two lines; the DATE is the mechanism. No rule splits CNS's `UE`.
**Superseded 2026-10-02:** previously "only Anti Infective splits; CNS and Pedia stay one flat UE" — Pedia's split is the later owner golden rule (THE AUGUST / UPPER EGYPT GOLDEN RULE).

**The bug this fixed:** the grid grouped areas by `source_of_sales_areas.region_code` (flat `UE`)
while the Direct channel already imports `UE-1`/`UE-2`. So Anti Infective rendered Upper Egypt
**three times** — one distributor block plus two direct-only orphan blocks named by bare code —
and neither manager could read their own number.

## 🔴 GZ6 WAS a mixed area — now split: Fayoum stays `GZ6`, Beni Suef is its own area `UE9`

Owner's exact words: *"only in Anti Infective, Fayoum belongs to GZ and Beni Suef belongs to
UE-1; in other lines these areas belong to GZ."*

**Current state:** the split was executed — Beni Suef was split out of GZ6 as its own area **`UE9`**
on 2026-08-03 (the first cut on 2026-08-02 is recorded with the codes `GZ8`/`GZ9` in
[[sos-area-split-requires-block-split]], which also holds the block-split mechanics; the live codes,
in `src/lib/sales/closing-area-merges.ts`, are `GZ6` Fayoum + `UE9` Beni Suef). On Anti Infective the
owner's rule is now honoured: Fayoum `GZ6` sits in region GZ (`SEAT-AIF-DM-GZ`/`SEAT-AIF-REP-GZ6`),
Beni Suef `UE9` in region UE-1 (`SEAT-AIF-ADM-UE-1`/`SEAT-AIF-REP-UE9`). How the pair folds or splits
per LINE is in [[fayoum-beni-suef-golden-rule-per-line]].
**Superseded 2026-10-02:** previously "GZ6 cannot be split yet; it stays in Giza; the real fix is not done" — the split itself (2026-08-02/03, `sos-area-split-requires-block-split`, `fayoum-beni-suef-golden-rule-per-line`).

The history of why it needed a split: `GZ6 "Fayoum-Beni Suef"` was **one area spanning two
governorates**, a sub-area split the data model could not express. Its 16 bricks straddled both, and **block B191 itself was mixed**
(`مدينة الفيوم` + `طميه` are Fayoum; `الوسطى`, `مدينة بنى سويف`, `مركز ناصر`, `بيبا`, `سامستا` are
Beni Suef), so no block-level grouping separates them either. June 2026 Anti Infective: Beni Suef
**75u / 8,185.05 EGP** vs Fayoum **6u / 666.90** — i.e. ~92% of the old GZ6 was really UE-1's.

On 2026-08-02 `au.line_area_map` said GZ6 -> `UE-1` for anti_infective with `SEAT-AIF-REP-GZ6` under
`SEAT-AIF-ADM-UE-1`. **Today** the split is done as above: Anti Infective's `GZ6` (Fayoum) is region
GZ and `UE9` (Beni Suef) is region UE-1, per the owner's 2026-08-07 seat ruling recorded in
[[fayoum-beni-suef-golden-rule-per-line]]. `بليفيا` (B127-66) was never classified either way.
**Superseded 2026-10-02:** previously "shipped state: GZ6 stays in Giza; real fix = split GZ6 into two areas — not done" — the GZ6/UE9 split (`sos-area-split-requires-block-split`, `fayoum-beni-suef-golden-rule-per-line`).

## The mechanism the code uses — organogram region grouping

The closing groups a line's areas on `au_v_line_area_map.operational_region_code` instead of the
area's static `source_of_sales_areas.region_code`: `applyOperationalRegions` +
`CLOSING_ORGANOGRAM_REGION_LINES` in `src/lib/sales/closing-organogram-regions.ts`, restricted to
`carries_target` rows ([[closing-sheet-groups-on-static-region-code]]). An area the map does not
cover keeps its geographic region. **Adding a line to that set rewrites that line's region
subtotals — ask the owner first.** (Read the set in the file before quoting it: the code comment
records Pedia and CNS joining Anti Infective there on the owner's 2026-08-07 ruling.)
**Superseded 2026-10-02:** previously "`isClosingRegionRefinement` adopts the organogram region only when it is the sheet region plus a suffix" — that function never existed (`closing-sheet-groups-on-static-region-code`, verified with `git grep --text`).

The paragraph below described what that non-existent predicate was meant to ignore; it is kept as
the record of the open Others question, not as a description of the code. The predicate was to IGNORE the same column's two other meanings — line-specific Others parking
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

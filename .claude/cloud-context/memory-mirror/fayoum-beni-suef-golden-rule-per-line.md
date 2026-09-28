---
name: fayoum-beni-suef-golden-rule-per-line
description: "GOLDEN RULE — Fayoum (GZ6) and Beni Suef (UE9) merge per LINE as a display fold (CLOSING_AREA_MERGES): Pedia up to and including 2026-08 (TWO areas from September), CNS from 2026-08, Anti Infective never. Two independent layers — the display fold vs the au.line_area_map seats — plus the sales geography, which is never touched. KNOWN DEFECT LEFT AS PUBLISHED: the Pedia August 2026 matrix drops Beni Suef's El Qema share (47,230.22 EGP) because the store split lands after the fold — never re-chase or retro-fix it, and check-sales-truth 2026-08 fails on exactly that one row forever."
metadata:
  node_type: memory
  type: project
  originSessionId: 8c6bec23-3b91-45b3-9b59-0166d0428297
  modified: 2026-09-26T01:07:09.834Z
---

Fayoum (`GZ6`) and Beni Suef (`UE9`, split out of GZ6 on 2026-08-03) merge **per line**, across **TWO
INDEPENDENT LAYERS plus the sales geography** — never conflate them.

## Layer 1 — the DISPLAY FOLD (`src/lib/sales/closing-area-merges.ts`), the live user-facing rule

Owner rule 2026-08-30: *"only one area in sales and in organogram and in everywhere … in line pedia
only … Also planning & coverage"* and *"Split CNS into two."*

- `CLOSING_AREA_MERGES` folds `GZ6`+`UE9` into **"Fayoum - Beni Suef"** on **`pedia`
  (`untilPeriod: "2026-08"` — owner 2026-09-09: two separate areas from September, August unaffected)
  AND `cns` (`fromPeriod: "2026-08"`)**. Anti Infective was never in it and must not be — its two areas
  are genuinely different DMs.
- 🔴 **CNS WENT OUT AND CAME BACK — do not "restore" the split.** It was removed ("split CNS into two"),
  then re-added gated to August onward. A session reading only the removal decision will read the live
  `cns` entry as a regression and delete it. **The `fromPeriod` is the tell that it is deliberate.**
- **Pedia shows ONE combined area on EVERY surface** — SoS dashboard `byArea`/pickers, organogram
  (`organogram-au-source.ts`), territory drilldown (`territory/skeleton.ts`), CRM coverage
  (`crm/coverage-filters.ts`), the monthly closing matrix (`applyClosingAreaMerges`), the weekly-planning
  area picker (`weekly-planning/planning-areas.ts`), and every `applyAchievementAreaMerges` caller.
  **Anti Infective shows TWO rows; CNS shows ONE from 2026-08, two before.**
- **It is a DISPLAY-ONLY fold, safe with NO access-scope change.** Pedia `GZ6` and `UE9` share one DM seat
  (`SEAT-PED-DM-GZ`) + rep seat, so every Pedia viewer who sees one already sees the other; the fold runs
  AFTER authorization (`keepExec` gates on the REAL area code), and a picked/scoped code is EXPANDED back
  to both real codes via `expandAreaCodeForLine` before any query, so nothing Beni Suef sold is lost
  (folded row units == GZ6 + UE9, and `sum(byArea) == totalValue`). **Anti Infective is correctly NOT
  folded** — its GZ6 (region GZ) and UE9 (region UE-1) are genuinely DIFFERENT DMs, so folding would cross
  a real access boundary. CNS shares one seat (`SEAT-CNS-OTHERS`), so its un-merge is display-only-safe too.
- **Helpers** (all normalize line via `.trim().toLowerCase()`): `getMergedAreaName`,
  `expandAreaCodeForLine`/`expandAreaCodesForLine` (GZ6→[GZ6,UE9]), `foldAreaCodeForLine` (UE9→GZ6),
  `foldAreaOptionsForLine`, `applyClosingAreaMerges`, `applyAchievementAreaMerges`, `hasClosingAreaMerges`.
- **Weekly planning is DONE with NO schema touch** — a plan stores the area NAME as free text
  (`WeeklyPlanDay.area`) and never filters sales by code. `loadPlanningAreaSeats` folds the seat list
  through `foldAreaOptionsForLine`, and because both the picker (`planningAreaOptions`) and the submit
  check (`planningAreaBelongsToRegion`) read that one seat list, folding it once covers both. A few
  historical plan rows storing "Fayoum"/"Beni Suef" separately were left as-is (cross-line name-collision
  risk).
- **Deferred, NOT done:** (1) the Delta-3 Anti Infective Ismailia (`OT2`)+Suez (`OT9`) merge is a SEPARATE
  date-gated change (Delta 3 exists only from 2026-09-01). (2) Latent hardening — `foldAreaOptionsForLine`
  blanks for a viewer scoped to UE9-alone (no such live viewer today); a proper fix also needs
  `skeleton.ts`'s `remapAreaCode`, which hard-assumes GZ6 is the survivor.

## Layer 2 — the ORGANOGRAM SEAT STRUCTURE (`au.line_area_map`), owner ruling 2026-08-07

Who STAFFS what (DM/rep seats, targets) — a different table from the display fold.

- **Anti Infective** — SEPARATE seats: Fayoum → `SEAT-AIF-DM-GZ`/`SEAT-AIF-REP-GZ6` (region GZ);
  Beni Suef → `SEAT-AIF-ADM-UE-1`/`SEAT-AIF-REP-UE9` (region UE-1).
- **Pedia up to 2026-08-31** — both `GZ6` and `UE9` share `SEAT-PED-DM-GZ`/`SEAT-PED-REP-GZ6` (region GZ),
  "one rep covers both halves," both `carries_target = true`.
- 🔴 **Pedia FROM 2026-09-01 — TWO AREAS, BOTH UNDER OSAMA MOHAMED EL-SAID (region UE-1).** Owner,
  2026-09-21, emphatic: *"STARTING SEPTEMBER FAYOUM IS A AREA AND BANI SUEF ANOTHER AREA … IN PEDIA LINE
  UNDER OSAMA."* Live in `au.line_area_map`: `GZ6` Fayoum → `SEAT-PED-DM-UE-1` + `SEAT-PED-REP-GZ6`;
  `UE9` Beni Suef → `SEAT-PED-DM-UE-1` + its OWN `SEAT-PED-REP-UE9` (vacant). **Never describe September
  Pedia as one merged area, never put Beni Suef back under Giza or on the old rep seat.** Undated surfaces
  (organogram, pickers, targets template) read today's Cairo month, so they already show two.
- 🔴 **September's Pedia TARGETS predate the split** (uploaded 2026-08-04) — `GZ6` alone carries the old
  COMBINED figure and `UE9` has none. It is the owner's to set on the Targets screen; **never write or
  split a target yourself.**
- **CNS** — both in region **OT (Others)**, `other_type = 'line_specific'`,
  `staffed_in_line_code = 'anti_infective, pedia'`, `carries_target = false`: no dedicated CNS rep. So
  CNS's Layer-1 split into two rows reflects the SALES DATA (always GZ6/UE9-separate), not a seat change.

## The SALES geography is never touched

`source_of_sales_areas` / `source_of_sales_fact_rollup` keep `GZ6` and `UE9` as two separate areas on
every line — an invoice still books to GZ6 or UE9 specifically. Both layers above only change who is
CREDITED and how areas are LABELLED/GROUPED for a viewer; neither moves where a sale's units land.

**How to apply:** before touching `GZ6`/`UE9` on any line, decide which layer you mean. Display
label/grouping → `closing-area-merges.ts` (Pedia only). Staffing/seats/targets → `au.line_area_map` (per
the 2026-08-07 split). A 4th roster line → ask the owner which pattern it follows, never assume. See
[[july-direct-overlay-and-rollup-must-move-together]] for a separate July-only Anti Infective exception.

## Layer 3 — El Qema's Upper Egypt block

`UPPER_EGYPT_AREAS` in `src/lib/sales/store-sales-city-split.ts` names **both `GZ6` and `UE9` explicitly**
(owner named both as Upper Egypt 2026-09-09), so on Pedia August BOTH take an identical El Qema share. The
block reads `operational_region_code` from the organogram, and the owner chose to **follow the organogram
rather than geography**: *"follow the organogram but later if we update the organogram the rule changes."*
So it is not an exception to maintain — moving the seat moves the rule, with no code change.

## 🔴 Known defect LEFT AS PUBLISHED — Pedia August 2026 loses Beni Suef's El Qema share

**Recognise it by:** the Total sheet of any Pedia August export whose scope holds "Fayoum - Beni Suef"
(NSM, PM, the Giza managers, Super Admin) shows a Difference of exactly **47,230.22**; scopes without that
area show 0.

- **Mechanism.** `loadMonthlyClosingPartsWithStoreSplit` takes the matrix from `loadMonthlyClosingParts`,
  which has ALREADY folded `UE9` into `GZ6`. The store-split net (`loadClosingStoreSplit`) is computed on
  detail rows where the two areas are still apart, so El Qema's Upper Egypt pass lands one share on `GZ6`
  and an identical one on `UE9`. `applyStoreSplitToMatrix` skips any delta whose area row is absent, so
  `GZ6`'s share lands on the folded row and `UE9`'s **vanishes** — no error, and the grand total the split
  is meant to conserve silently shrinks (the folded area shows ~61k against a ~108,608.44 true figure).
- **Who reads it.** Only the closing surfaces call that loader (admin page, portal, premium and
  consolidated exports, quarter gap, performance review, sales truth report), so they all agree with what
  was announced. No payroll, incentive, KPI or target code calls it.
- **Status — do NOT fix, do NOT re-raise.** Published 2026-09-10, locked since 2026-09-14. Stays as
  published under [[never-fix-a-published-and-announced-month]]; re-confirmed by the owner — *"fayoum and
  banii suef starting from septembver dont touch august."*
- **The OTHER side keeps the share, so the two disagree for August forever.** Sales vs Target
  (`phx_sales_vs_target_range`) builds its split net with `keepMergedAreasApart`, so it credits
  "Fayoum - Beni Suef" the full 108,608.44 — and so do Employee 360, the portal and the Business Review
  for the rep who held both seats in August. `scripts/check-sales-truth.ts 2026-08` therefore always FAILS
  on exactly this one Sales vs Target row (+47,230.22). **That is this decided defect, not a new finding —
  do not re-chase it and do not "align" either side.**
- **No later month is exposed.** Pedia stops folding after 2026-08 (`untilPeriod`), so from September
  `UE9` keeps its own row and share. CNS folds from 2026-08, but `splitTargetsFor` returns the row's
  own-city block unless El Qema's rule applies (Pedia only), and Fayoum and Beni Suef are one-area cities
  in `AREA_CITY`, so `UE9`'s CNS movement nets to zero. **It returns only if a folded pair can receive a
  share from outside its own city** (El Qema's rule reaching CNS, a second area in the Fayoum/Beni Suef
  city, or a new fold on a Pedia period). If that happens, apply the split BEFORE the fold (or fold the
  net's area codes with `foldAreaCodeForLine`) and prove the Total sheet Difference reads 0. See
  [[el-qema-three-bands-plus-upper-egypt]].

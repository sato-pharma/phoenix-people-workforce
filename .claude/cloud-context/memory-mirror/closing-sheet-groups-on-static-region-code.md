---
name: closing-sheet-groups-on-static-region-code
description: "Monthly Closing groups areas on source_of_sales_areas.region_code alone — there was never an isClosingRegionRefinement helper, despite a task brief claiming it already shipped."
metadata: 
  node_type: memory
  type: project
  originSessionId: dbeeacdb-b7cc-4cd4-b517-18db2d3e2f41
  modified: 2026-08-02T14:18:02.580Z
---

2026-08-02. A task brief stated the closing side was "already done" via
`isClosingRegionRefinement` in `src/lib/sales/monthly-distributor-import.ts`, which "adopts the
organogram region only when it sub-divides the sheet region".

**That function has never existed.** Zero hits from ripgrep AND `git grep --text` across the whole
repo, and it was in no open PR. `buildMonthlyClosingMatrix` grouped areas on `area.regionCode`
directly, sourced by `listActiveSalesAreas` straight from `source_of_sales_areas.region_code`.
There was no refinement rule to widen — the work had simply never been built.

**Why it matters:** an area carries ONE static `region_code`, so any per-LINE region rule is
inexpressible on the area row. Fixed by grouping Anti Infective's sheet on
`au_v_line_area_map.operational_region_code` instead (`applyOperationalRegions` +
`CLOSING_ORGANOGRAM_REGION_LINES`), restricted to `carries_target` rows.

**Scope is deliberately Anti Infective only** (owner decision). Applying it to every line moves
**13** areas, not one: AIF's 9 are wanted (Beni Suef `GZ→UE-1`, plus `UE1/UE2→UE-1` and
`UE3–UE8→UE-2`, the Upper Egypt DM split), but CNS would also move Down town `CA→GZ` and
Kafr El-Sheikh 1 `D1→AB`, and Pedia would move Kafr El-Sheikh 1 `D1→AB` and Helwan-Maadi `GZ→CA` —
silently restating two monthly sheets. **Adding a line to that set rewrites that line's region
subtotals; ask first.**

Also note `MONTHLY_CLOSING_REGION_ORDER` had no `UE-1`/`UE-2`, so those ranked last and would have
rendered at the bottom of the sheet. And the skeleton.ts comment claiming
`source_of_sales_regions` "has only one plain UE row" is **stale** — it carries UE, UE-1 and UE-2.

**How to apply:** verify a claim like "X already handles this" with `git grep --text` before
building on it. See [[sos-area-split-requires-block-split]] for the geography half of this work.

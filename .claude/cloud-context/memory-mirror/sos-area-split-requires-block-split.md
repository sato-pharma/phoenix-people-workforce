---
name: sos-area-split-requires-block-split
description: "Splitting a SoS area at BRICK level forces a BLOCK split — a brick inherits its area through its block's composite FK. Plus the 3 traps hit doing GZ6 → Fayoum/Beni Suef."
metadata: 
  node_type: memory
  type: project
  originSessionId: dbeeacdb-b7cc-4cd4-b517-18db2d3e2f41
  modified: 2026-08-02T14:17:50.501Z
---

2026-08-02. Split `GZ6 "Fayoum-Beni Suef"` into `GZ8 Fayoum` (6 bricks) + `GZ9 Beni Suef` (10) so
the owner's per-line rule ("only in Anti Infective, Beni Suef belongs to UE-1") became expressible.

**You cannot move a brick between areas on its own.** `source_of_sales_bricks` FKs to
`source_of_sales_blocks` on the composite `(block_code, area_code, region_code)`, and a block
belongs to exactly ONE area. Mixed block B191 therefore had to be split — its two Fayoum bricks
moved to a new block B221. All three hierarchy FKs are `ON UPDATE CASCADE`, so repointing a
block's `area_code` carries its bricks automatically; only bricks changing *block* need an
explicit update.

**Three traps that each cost a failed apply or would have shipped wrong:**

- `au.line_area_map.carries_target` is **GENERATED ALWAYS** as
  `(area_state in ('occupied','vacant_will_hire'))`. Listing it in an INSERT is a hard error.
  Same class as [[deductions-module-god-mode]]'s `month_key`.
- Trigger `phx_assert_master_brick_in_block` blocks inserting a block whose `master_brick_id`
  isn't in it *yet*. Insert the block with `master_brick_id = null`, move the bricks, then set it.
- `source_of_sales_areas.ims_ratio` feeds a **hard-coded** invariant in `src/lib/sales/ims-ratio.ts`
  (`IMS_NON_OT_TOTAL = 0.9503`, active non-OT areas). A split must divide the old ratio so the sum
  is preserved — GZ6's 0.0258 became 0.0147 + 0.0111 (exact at 4dp).

**`au.sos_area_crosswalk.brick_scope` is NOT a brick list** — it is
`check (brick_scope in ('all','specific'))` with no list column anywhere, and all 49 rows are
`'all'`. It looks like the hook for a sub-area split; it isn't. Confirms
[[sos-areas-must-never-be-deleted-au-linkage]].

**Retire, never delete:** GZ6 went `active=false` on `source_of_sales_areas`,
`source_of_sales_area_regions`, `sales_area_region_codes` AND `au.canonical_areas.is_active` — the
OT3 precedent. Note `listActiveSalesAreas` filters `active=true`, so a retired area silently
disappears from Monthly Closing; move its rows off it first or the sales vanish.

**How to apply:** before splitting any area, check `brick_id` coverage on
`source_of_sales_{customer_map,fact_rollup,customer_directory_rollup,import_rows}` — the split is
only derivable if bricks are populated (GZ6 was 26,269/26,275). Rows with an EMPTY-STRING (not
null) `brick_id` are the unmapped-customer tail and need an explicit destination.

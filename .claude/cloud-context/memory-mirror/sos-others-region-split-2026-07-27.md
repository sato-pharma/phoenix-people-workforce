---
name: sos-others-region-split-2026-07-27
description: "The OT \"Others\" region was split from 3 areas into 9 on 2026-07-27; OT3 Aswan retired; geography master now 48 areas / 212 blocks / 1036 bricks"
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-27T20:25:29.211Z
---

**Applied to production `ozucdzovmcqvepbozvqf` 2026-07-27 ~22:15 Cairo**, from
`FINAL NEW (5).xlsx` (627 rows), after a fix-by-fix review with the owner.

| | Before | After |
|---|---|---|
| active areas | 42 | **48** (+7 new, −1 retired) |
| active blocks | 211 | **212** |
| active bricks | 1005 | **1036** |
| customer_map / fact_rollup | 49,712 / 158,258 | **unchanged** |

The old `OT3` was a catch-all *named* "Aswan" that actually held Aswan, Luxor, Red Sea,
New Valley and Hurgada. It is now split into: `OT4` New Valley, `OT5` Hurgada, `OT6` Luxor,
`OT7` Aswan, `OT8` Red Sea, `OT9` Ismailia, `OT10` South Sinai (`OT2` narrowed to Suez only).
`OT3` retired — **row kept, `active=false`** — because 1,780 customer_map / 5,853 fact /
7,833 import rows still carry `area_code='OT3'`.

**Post-migration browser verification caught a miss:** the migration created the 7 new areas but never
RENAMED `OT2` from "Suez/ South Sinai" to "Suez" after South Sinai moved out to `OT10` — so two areas
both claimed South Sinai for ~1h. Fixed 2026-07-27 across all 5 name-carrying tables. **Lesson: post-migration
checks that only count rows and validate FKs will not catch a stale NAME. Always diff area/block names
against the source workbook too.**

## Traps hit during execution — check these on any future area work

1. **`normalized_area_name` has a UNIQUE index** on `source_of_sales_area_regions` AND
   `sales_area_region_codes`. New `OT7` "Aswan" collided with the old `OT3` "Aswan".
   Fix: renamed OT3 to "Aswan (Legacy)" first, which freed the name.
2. **`au.line_area_map.carries_target` is a GENERATED column**
   (`area_state IN ('occupied','vacant_will_hire')`). Never insert it explicitly — it errors.
3. **`source_of_sales_bricks` FK to blocks is `ON UPDATE CASCADE`.** Updating a block's
   `area_code` automatically moves every brick on it, *including inactive ones*. This is how
   all 18 OT3 bricks (14 active + 4 inactive on B142) moved without being listed.
   Do NOT hand-update brick area_code when moving a block — it is already done.

## Others routing (owner rule, verified in the data)

Others areas are places the company **will never hire into**, but that still generate sales.
Chain: OT area → `SEAT-{AIF,CNS,PED}-OTHERS` pseudo-DM (`is_other_pseudo_dm=true`,
**no occupant**, no target) → parent NSM seat → line total. Never reaches a real DM or med rep.
All 21 new `line_area_map` rows verified: `carries_target=false`, `rep_seat_id=NULL`.
See [[au-schema-is-the-org-sos-linkage]].

## Still open

- **Customer/sales remap NOT done — deliberately.** Owner is widening scope to map sales into
  ALL bricks from scratch, so the old crosswalk work is superseded. Do not re-use
  `final_crosswalk.json`.
- 1,252 `customer_map` rows whose `area_code` disagrees with their own brick's area (pre-existing).
- IMS ratios: 39 areas sum 95.03% + Others 4.97%. No column exists yet — spun off as its own
  task (add `ims_ratio` to `source_of_sales_areas`).
- Two Database Mapping UI gaps: `listMasterRows` has no `active` filter so inactive bricks show
  mixed with active; Brick Master shows Block Code without Block Name.

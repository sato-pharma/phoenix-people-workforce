---
name: repointing-a-block-area-leaves-crosswalk-and-directory-stale
description: "Re-pointing a BLOCK to a new area cascades to bricks via FK but silently leaves source_of_sales_customer_map and customer_directory_rollup on the old area — the mirror image of the relocateBrick trap"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3e434f03-8c09-4507-8536-4a161cf961b0
  modified: 2026-08-05T22:30:44.428Z
---

A **block-level** area change is a different code path from [[moving-a-sos-brick-between-areas-needs-four-restamps]]
and leaves the **opposite** residue. Updating `source_of_sales_blocks.area_code` propagates down to
`source_of_sales_bricks` automatically — the composite FK
`source_of_sales_bricks_block_hierarchy_fk (block_code, area_code, region_code)` is
**`ON UPDATE CASCADE`** — and it does NOT bump `bricks.updated_at`, so the master looks untouched
while its area has in fact moved. Nothing below bricks has any FK, so nothing else moves at all.

**Confirmed live 2026-08-06 (prod `ozucdzovmcqvepbozvqf`).** Area `UE9` "Beni Suef" was created
2026-08-03 21:09 Cairo, split out of `GZ6` "Fayoum"; blocks B127/B128/B191 were re-pointed to it.
Whoever did it re-stamped `import_rows` and `fact_rollup` by hand but missed the other two, leaving
**915 rows / 11 bricks stale in `source_of_sales_customer_map` and 2,346 rows / 10 bricks in
`source_of_sales_customer_directory_rollup`**. Region drift was 0 — an intra-region split moves only
the area, so a region-based check sees nothing.

**Why it matters — this is not cosmetic.** `customer_map.area_code` is read directly by six DB
functions, and `phx_closing_customers` outputs `coalesce(cm.area_code, <fact rollup area>)` — it
**prefers the stale crosswalk over the clean fact table**, so Monthly Closing reports the old area.
`customer_directory_rollup.area_code` is filtered by `phx_customer_directory`, `phx_exec_customers`,
`phx_territory_area_pharmacies` and `phx_closing_channel_breakdown`, none of which re-join bricks.
Measured symptom: Fayoum's customer directory was 48% Beni Suef clients (828 of 1,735).

**How to apply:** after ANY block area re-point, re-stamp all four downstream tables, not just the
fact ones. The give-away that a table was re-stamped and another was not: rows whose `created_at`
predates the new area's `created_at` yet already carry the new code can only have been updated in
place. Dating the split by the AREA row's `created_at` (`source_of_sales_areas`), then splitting each
table's rows on that instant, proves stale-vs-deliberate in one query — every drifting row landing
before the cut and none after means leftover data, not a business decision.

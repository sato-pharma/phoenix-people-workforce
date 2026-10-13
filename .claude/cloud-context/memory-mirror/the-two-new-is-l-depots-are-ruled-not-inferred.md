---
name: the-two-new-is-l-depots-are-ruled-not-inferred
description: "Both IS-L depots are settled by his own word on 13 Oct 2026 — `04` Platform Delta stays Gharbia 1 (Tanta), `A2` Assiut 2 Warehouse takes Assuit 2 (`UE4`); never re-infer either from the \"warehouse = region, no area\" precedent."
metadata:
  node_type: memory
  type: project
  originSessionId: 4fc4cc23-d36a-4eb9-90b2-febaa1978bd8
  modified: 2026-10-12T23:58:42.693Z
---

The Ibn Sina Lacto feed (`IS-L`) brought two depots `weekly_sales_branch_region_map` had never
seen. I seeded both from precedent and flagged both as judgement calls; he ruled on each, 13 Oct
2026, 02:1x–02:5x Cairo:

- **`A2` Assiut 2 Warehouse** — *"wire to assuit 2"*. It had been seeded region-only (`UE` Upper
  Egypt, no area) following `AS` Almaza Storage, `B1` Benisuef 2 Warehouse and `O1` October Regional
  Warehouse. Overruled: `area_code` = **`UE4`**, the area master's own code for "Assuit 2" (spelled
  that way in `source_of_sales_areas`, which is why the code and not the name is written). Shipped
  as migration `20261013120001_weekly_isl_a2_warehouse_takes_assuit_2.sql`, PR #5824 → `a07e9467e`.
- **`04` Platform Delta (Tanta)** — *"keep 04 platform delta on gharbia 1"*. Stays as seeded:
  region `D1` Delta (1), area **`D14`** Gharbia 1 (Tanta), after `T7` Platform Alexandria
  (Kabary2) at `AB`/`AB3`. No change was needed and none was made.

Read back on **both** environments 13 Oct 2026 02:58 Cairo — staging `cifwmndunmlxjhyjugxa` and
production `ozucdzovmcqvepbozvqf` agree row for row.

**Why:** the region-only rows on those three warehouses are how they happened to be mapped, not a
policy, so inferring an area from a depot's name is guessing at a business fact. Both of these are
now HIS answers, not inferences — and a session that "tidies" `A2` back to region-only, or moves
`04` on the warehouse reading, is undoing a ruling, not fixing a defect.

**How to apply:** treat both placements as settled and never re-open them. For the NEXT unseen
depot in any feed, map the region, then ask him for the area as in-chat multiple choice — do not
infer it. Record the answer as a migration even when the Branch Mapping tab could do it: the seed
migration is how the row exists, so a rebuild from migrations would restore the old value and
silently undo the ruling. See [[the-ibn-sina-lacto-misr-export-is-a-second-supplier-feed-in-the-is-s-template]].

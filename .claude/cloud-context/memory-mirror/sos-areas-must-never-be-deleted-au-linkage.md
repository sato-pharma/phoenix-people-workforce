---
name: sos-areas-must-never-be-deleted-au-linkage
description: "Never DELETE source_of_sales_areas rows — au.* references them with NO foreign key, so deletes break the org↔SoS 1:1 invariant silently. Deactivate instead."
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-28T18:10:29.473Z
---

2026-07-28. While building the SoS master replace I nearly deleted `source_of_sales_areas.OT3`
because the new master doesn't list it. Caught in a self-audit before production.

**Only two FKs point at `source_of_sales_areas`** (`source_of_sales_area_aliases`,
`source_of_sales_blocks`), so a constraint scan says an area is safe to delete. It lies —
the `au` schema references SoS area codes with **no foreign key at all**:

| Table | Column | Prod rows | OT3 rows |
| --- | --- | --- | --- |
| `au.canonical_areas` | `area_code` | 49 | 1 (`Aswan (Legacy)`, `is_active=false`) |
| `au.sos_area_crosswalk` | `sos_area_code` + `canonical_area_code` | 49 | 1 |
| `au.line_area_map` | `area_code` | 147 | 3 (all `effective_to=2026-07-27`, i.e. history) |
| `public.sales_area_region_codes` | `area_code` | 49 | 1 |
| `public.source_of_sales_area_regions` | `area_code` | 49 | 1 |

OT3 is a **deliberate retired placeholder kept on BOTH sides**: `source_of_sales_areas.OT3.active
= false` AND `au.canonical_areas.OT3.is_active = false`. Prod is already 49 areas / 48 active.
Deleting it would break the documented 1:1 ([[au-schema-is-the-org-sos-linkage]]) and orphan
3 historical `line_area_map` rows — with nothing raising an error.

**How to apply:** in any SoS master load, areas are `update ... set active=false`, NEVER
`delete`. Blocks and bricks may be deleted (nothing outside SoS references them without an FK —
verified by scanning `information_schema.columns` for brick/block columns across
public/analytics/au/internal/private). `au.sos_area_crosswalk.brick_scope` is the literal
`'all'` for all 49 rows — it is NOT a brick list.

Two verification traps hit while checking this:
- Passing an Arabic character-class regex (`'[؀-ۿ]'` written literally) through a
  bash `psql -c` gets mangled and matches nothing, so "0 Arabic blocks" reads as "129 broken".
  Use `description ~ '^[[:ascii:]]*$'` to find English rows instead — no literal Arabic in SQL.
- Staging's `au.canonical_areas` has only **42** areas (pre-Others-split) vs prod's 49, so
  org↔SoS invariant checks on staging give false positives. See [[sos-final-new-4-xlsx-is-pre-split]].

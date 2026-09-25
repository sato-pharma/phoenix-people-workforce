---
name: au-schema-is-the-org-sos-linkage
description: "The organogram<->Source-of-Sales area linkage lives in the `au` schema (not public); au.sos_area_crosswalk maps all 50 canonical areas 1:1 to SoS area codes — it was 42 when this was written, so read the count, never hard-code it"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-27T07:25:23.104Z
---

Area Unification put the organogram/SoS linkage in a dedicated **`au` schema**, not `public`.
Querying only `public` gives a wrong picture — `public.areas` has 132 rows where the 42 unified
areas show `line_id = NULL`, which looks like "not linked to any line" but is not the real model.

Real structure (production, verified 2026-07-27):
- `au.canonical_areas` — 42 canonical areas (area_code, area_name, code_region_code, sort_order)
- `au.sos_area_crosswalk` — 42 rows, **1:1 identity**: `sos_area_code = canonical_area_code`,
  `brick_scope = 'all'`. **The organogram area code IS the SoS area code** — one shared namespace.
- `au.line_area_map` — 125 rows = line x area. Each line assigns its OWN
  `operational_region_code` + `area_state` + seats over the same 42 areas, so the region differs
  per line (e.g. GZ5 Helwan-Maadi = GZ for anti_infective/cns but CA for pedia).
  anti_infective 42, cns 42, pedia 41 (pedia has no UE8 Qena 2).
- Also `au.seats`, `au.occupancy_history`, `au.monthly_targets`, `au.regions`, `au.lines`,
  `au.area_migration_map`, `au.sos_official_line_map`.

**`au` is NOT exposed via PostgREST** (only `public`, `graphql_public`, `analytics`), so
`Accept-Profile: au` returns PGRST106. Read it either through MCP `execute_sql`, or via the
`public.au_v_*` wrapper views: `au_v_line_area_map`, `au_v_canonical_areas`, `au_v_regions`,
`au_v_org_tree`, `au_v_org_structure_kpis` — those ARE reachable over REST.

**Migration consequence:** because area codes are one shared namespace, any SoS master change
that re-points an area code silently re-points the organogram too. See
[[sos-owner-standing-rules-from-session-369dd08d]] — the new.xlsx D17/D21/D22/GZ7 recycling would hit
`au.canonical_areas`, `au.sos_area_crosswalk` and `au.line_area_map` as well, and GZ7 carries
real live seats (SEAT-CNS-REP-GZ7, SEAT-PED-REP-GZ7).

## 2026-09-04 — re-measured on production, every count in the table above has moved

The **structure** is unchanged and still correct. The **counts** are not. Measured on
`ozucdzovmcqvepbozvqf`:

| | recorded 2026-07-27 | live 2026-09-04 |
| --- | --- | --- |
| `au.canonical_areas` | 42 | **50** (49 active) |
| `au.sos_area_crosswalk` | 42, 1:1 | **50**, still 1:1 |
| `au.line_area_map` | 125 | **155** (147 open, 8 closed) |
| open rows for `cns` | 42 | **49** |

Two traps sit in re-measuring this, and both cost a query here:

- **`line_code` is lowercase** — `cns`, `anti_infective`, `pedia`. A filter written `line_code = 'CNS'`
  returns **0 rows**, which reads as *the line has no areas* rather than as a typo.
- **`au.line_area_map` now carries closed rows** (`effective_to` not null) — 8 of them, from the
  Delta (3) move. A count without `effective_to is null` double-counts a moved area.

**Why 42 became 50 matters more than the number.** The figure was never a constant: the geography
grows as areas are split and the Delta (3) move dated new rows. Any code or answer that hard-codes
42 is wrong now and any that hard-codes 50 will be wrong later. See
[[attribution-is-period-aware-asof-not-todays-geography]] — the same lesson from the other side.

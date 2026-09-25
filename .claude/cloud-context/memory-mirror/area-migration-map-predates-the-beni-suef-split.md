---
name: area-migration-map-predates-the-beni-suef-split
description: "au.area_migration_map still folds 'Bani suef' into Fayoum (GZ6) — it was built before UE9 Beni Suef was split out on 2026-08-03, so any old→new area backfill silently misallocates Beni Suef"
metadata: 
  node_type: memory
  type: project
  originSessionId: b999e9ef-030a-4843-87cb-dfb024f13c09
  modified: 2026-08-13T22:06:13.466Z
---

`au.area_migration_map` (keyed by `public.areas.id`, an old bigint) is the obvious tool for mapping a
pre-unification territory name onto today's `area_code`. It is right for almost everything and
**stale for Beni Suef**: `old_area_id = 14` (`bani_suef`) maps to `canonical_code = 'GZ6'` (Fayoum),
because the map was authored before `UE9 Beni Suef` was split out of GZ6 on 2026-08-03. Confirmed
live in production 2026-08-14.

Beni Suef is not a rounding error — in H1 2026 it carries real SoS sales on all three lines
(Anti Infective 721 units, CNS 1,652, Pedia 631) while Fayoum has only 45 Anti Infective units. A
backfill that trusts the map puts Beni Suef's whole target on Fayoum and leaves Beni Suef with sales
and no target, so both areas read a wrong achievement %.

Two other rows in the same map carry `confidence = 'ambiguous'` and a `note` saying so, and they are
merges the owner has to rule on, not spelling fixes: `Dakahlia 4 → D23` ("Dakahlia 4 (no canonical)"),
`Sharkia 3 → D25` ("Sharkia 3 (no canonical)"), `Faisal & October → GZ4`, `Alex - Behiera → AB4`,
`Shoubra & Shoubra El Kheima → D11`, `Haram, Giza midan, Giza Centers → GZ4`, `Alex-Delta → AB1`.

**Why:** the map is a point-in-time artefact of the 2026 area unification. Geography kept moving
after it was written; nothing re-stamps it.

**How to apply:** never use `au.area_migration_map` as the sole authority for an old→new area
backfill. Filter to `confidence = 'high'`, then re-check every hit against `au.canonical_areas` and
`au.line_area_map.carries_target` for the line in question, and put anything ambiguous in front of
the owner as an XLSX ruling row — see [[ask-business-facts-via-xlsx-dropdown-sheet]]. The
per-line staffing rule for these two areas is [[fayoum-beni-suef-golden-rule-per-line]]; the target
re-pricing rule for the same backfill is
[[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]].

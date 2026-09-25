---
name: territory-drilldown-module-build
description: "New Territory & Sales Drilldown employee-portal module (Region>Area>Block>Brick>Pharmacy), all 4 sales roles shipped; key lesson — area/region scoping must come from the organogram seat structure (au_v_line_area_map), not raw geography"
metadata: 
  node_type: memory
  type: project
  originSessionId: 83931272-497c-4579-a106-0ac0fe1501fb
  modified: 2026-07-20T23:54:18.649Z
---

Built a new employee-portal module, **Territory & Sales Drilldown**
(`/employee-portals/territory-drilldown`), for all sales roles: a geography-rooted
sales tree (Region → Area → Block → Brick → Pharmacy) so each role sees exactly
where their sales number comes from, by name, never by code. Desktop = org-chart
style (matching the People Organogram's visual language); mobile = fully separate
native-`<details>` accordion. All four sales roles shipped: Medical Rep, District
Manager, Regional Manager, National Sales Manager — built and validated in that
order, one PR (#1229 on branch `codex/territory-drilldown`), each role's slice
gated behind full validation of the previous one.

**Why:** owner wanted this because reps/managers had no way to see *where* their
number came from geographically — only totals. Explicit owner requirements: hard
server-side lock per role (not just UI default — this reopened a region-only
scoping decision the owner had rejected twice before, with fresh explicit
authorization), line-filtered pharmacies (a pharmacy can sell multiple lines),
lazy-load per area, internal-only self-reconciliation for v1 (not cross-system
vs. the legacy Sales Queue pipeline).

**The core lesson (discovered mid-build, not anticipated by the original plan):**
A geographic region routinely has a **separate manager seat per product line** —
e.g. one region can have distinct Anti Infective / CNS / Pedia District Managers,
each covering a *different subset* of that region's areas. Scoping a manager's
area list by region alone (the original plan's assumption — "line only bites at
the pharmacy leaf") leaks a sibling line's areas into the tree. Confirmed for
real: a District Manager's own region had 7 areas, but her organogram seat only
covered 5 — the other 2 belonged to that region's CNS/Pedia DMs.

**How to apply — the fix, now the standing pattern for this module:**
- Area identity/name/existence always comes from `au_v_canonical_areas` /
  `au_v_line_area_map` (same tables the People Organogram reads via
  `au.v_org_tree`), never raw `source_of_sales_areas` — verified a clean 1:1
  match today, but organogram is the source of truth by construction, not luck.
- A manager's area list is scoped by **line AND region together**, via
  `au_v_line_area_map.carries_target = true` (same seat-occupancy data
  `loadTargetableAreas` in `monthly-targets.ts` already used) — not region alone.
- The server-side 403 boundary (`isAreaInRootScope` in
  `src/lib/sales/territory/service.ts`) shares the *exact same* line-scoped
  lookup the tree uses (`loadLineAreas` in `skeleton.ts`), so they can't diverge.
- Region **naming** also needed its own fix: some lines split a region more
  granularly at the organogram level than `source_of_sales_regions` does (Anti
  Infective splits Upper Egypt into "UE-1"/"UE-2" DM territories with no
  matching SoS region row). Added `public.au_v_regions` (new migration,
  `20260721120000_au_public_wrapper_regions.sql`, mirrors the existing
  `au_v_canonical_areas`/`au_v_line_area_map` wrapper-view pattern) as the name
  source, deriving the region list from the *final resolved area list* rather
  than independently from a region master table — this is what makes it correct
  for every root level (area/region/nationwide) without special-casing any one.
- If any future module needs "which areas/regions does role X see", reuse
  `resolveAuLineCode`/`loadLineAreas`/`loadCanonicalAreas` from
  `src/lib/sales/territory/skeleton.ts` rather than re-deriving this — Source of
  Sales / Weekly Sales / Admin Analytics do NOT do this (confirmed via research:
  they all use raw `source_of_sales_areas`/`source_of_sales_regions`, which is
  fine for their read-only dropdown/breakdown use case but would be wrong for
  anything presented as "your own territory").

**State at last touch:** PR #1229 open, CI green (`mergeStateStatus: CLEAN`),
not yet merged — merge needs separate explicit owner approval per AGENTS.md.
Migrations already applied to staging (`cifwmndunmlxjhyjugxa`) and production
(`ozucdzovmcqvepbozvqf`): the two territory RPCs
(`phx_territory_resolve_sos_area_codes`, `phx_territory_area_pharmacies`) and
`public.au_v_regions`. Worktree `_wt-territory-drilldown` — not yet cleaned
(awaits the PR merging first, per [[parallel-work-model-2026-07]]'s
delete-on-merge ritual).

See also [[au-phase9-cutover-validation]] and
[[area-unification-42-areas-audit-findings]] for the underlying Area
Unification project this module's area/region source-of-truth choice depends on.

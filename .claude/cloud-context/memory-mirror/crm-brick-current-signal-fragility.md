---
name: crm-brick-current-signal-fragility
description: "CRM region/customer-mapping \"is this brick current\" heuristic was fragile (effective_from alone); fixed via a source_file blocklist. PR #1426 MERGED 2026-07-28 (squash 525558d7) and LIVE in production — the body records the deploy; only this line still said \"open\"."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d20aeb9-9413-4a9f-b937-e9c675075ca7
  modified: 2026-07-28T17:06:26.397Z
---

`src/lib/crm/region-brick.ts`'s `getActiveBricksForTemplateReference()` (Region Mapping
template's brick reference/dropdown) and `getCurrentBrickIndex()` (shared validation for both
Region Mapping and Customer Mapping resolvers) decide "is this brick current, not a superseded
pre-rebuild brick" per area. Original heuristic (PR #1410): a brick counts as current if
`effective_from IS NOT NULL`; an area with zero current-tagged bricks falls back to offering
everything (untouched-by-rebuild areas).

That broke 2026-07-28: a same-day addition (`source_file = "Master of Master (FIXED).xlsx"`,
2 bricks: B182-77 in area AB4, B207-32 in area D26) landed without `effective_from` stamped, in
areas already flagged "rebuilt" by earlier 07-27 imports — so the new bricks were silently
excluded, indistinguishable from legacy junk. User caught it via "the new areas and bricks are
now live in /sales/database-mapping fix the crm mapping templete" (`/sales/database-mapping`
reads `source_of_sales_bricks` with zero filtering — `listMasterRows()` in
`src/lib/sales/master-data/list.ts`, so it shows literally everything; it is NOT the thing to
mirror, since it has no "current" concept at all).

Fix (PR #1426, unmerged as of 2026-07-28): added `isCurrentlyTaggedBrick()` — a brick is current
if `effective_from IS NOT NULL` **OR** its `source_file` is anything other than the one confirmed
bulk pre-rebuild legacy import (`Vlookup-Masterrr.xlsx`). Verified against production: every other
distinct `source_file` among active bricks (`FINAL NEW.xlsx`, `FINAL NEW (5).xlsx`, the 07-23/24
`manual:*` batches, `manual:d3_geography_rebuild_from_master`, plus 3 small one-off patches) is
either already effective_from-tagged or a genuine one-off correction — never a bulk legacy
re-import. 751 bricks now offered (was 746), both new bricks present with correct area/region.

**Why:** `effective_from` is a positive signal that depends on every future import remembering to
stamp it — a single ungoverned insert (a manual "just add this one brick" fix, exactly what
happened here) silently breaks the template the moment that brick's area was already rebuilt once.
A negative blocklist (name the one known-legacy source, treat everything else as current) doesn't
have this failure mode — it only breaks if someone re-imports a full legacy snapshot under a new
filename, which is a much rarer, more visible event.

**How to apply:** if a future report says "a brick/area doesn't show up in the CRM mapping
template (or gets rejected by the customer/region-mapping bulk import)" while the same brick is
visible in `/sales/database-mapping` or the raw `source_of_sales_bricks` table, check
`isCurrentlyTaggedBrick()` and `LEGACY_SOURCE_FILES` in `region-brick.ts` first — either the
brick's `source_file` needs recognizing, or (much less likely now) a genuine legacy bulk
re-import needs adding to the blocklist. Related: [[sos-owner-standing-rules-from-session-369dd08d]],
[[territory-management-module-plan]], [[brick-coordinates-are-geocoded-guesses]].

PR #1426 MERGED 2026-07-28 (squash commit `525558d7`) and deployed to production (workflow run
30380504915, full no-traffic/smoke-test/promote sequence, ~9m50s) — LIVE.

---
name: brick-area-is-the-blocks
description: "A SoS brick area cannot be updated - the block hierarchy FK owns it; move a town by activating or creating a brick under a block in the destination area, never deactivate the old one, and repoint the territory ALIASES or the next import rebuilds the problem. Also: the mapping guard parks such a write until sos_map_guard_decide releases it; the source column names a label the writer chose and never a route; and the application cannot set phoenix.actor, so its guard-log rows read as direct SQL."
metadata: 
  node_type: memory
  type: project
  originSessionId: 78a0b5c0-ff09-4ba9-bb02-a2fd6e5d2644
  modified: 2026-09-11T10:14:29.908Z
---

`update source_of_sales_bricks set area_code = ...` **always fails** — FK
`source_of_sales_bricks_block_hierarchy_fk` on `(block_code, area_code, region_code)` must exist in
`source_of_sales_blocks`, and a block belongs to exactly one area. A brick's area is **inherited,
never set**. To move a town to another area you activate (or create) a brick under a block that
already sits in the destination area, and repoint the customers and the open month's import rows.

**Do NOT deactivate the old brick.** `loadSalesReferenceData` selects bricks with `.eq("active",
true)`, and `monthly-closing-details.ts` computes `brickUnmapped: Boolean(brickId) && !brick` from
that map — so deactivating a brick that carries closed-month history lights up **"Data quality —
brick not in Phoenix master"** on every one of those rows, in months that are locked and published
and cannot be restated. Leave it active, set `effective_to` and a `description` to mark it
historical: nothing filters bricks on the effective dates, so they are documentation only.

Two active bricks with the same name in two areas is **allowed and correct** — only `brick_id` is
unique, the importer resolves by id, and duplicate brick names already exist deliberately
(see [[sos-duplicate-brick-names-are-decoys]]). It is how the master carries "this town was area X
until July, area Y from August".

Worked example: فوه (Fuwwah), 2026-09-04 — `B200-5` (block B200 → Kafr El-Sheikh 2) left active for
Jan–Jul, `B199-9` (block B199 → Kafr El-Sheikh 1) reactivated, 292 customers and 116 August rows
repointed, rollups and `au.f_refresh_monthly_attribution('2026-08')` rerun. Pre-image in
`fuwwah_backup_20260904`. Related: [[attribution-is-period-aware-asof-not-todays-geography]],
[[sos-bricks-are-the-authority-for-branch-to-area]].

Second worked example: باب الشعرية, 2026-09-11 — nothing to reactivate, so `B28-47` was **created**
under block B28 (already Down town), its customers repointed, `B17-28` left active in Cairo East 1
with the customers already its own. `source_sheet` is **NOT NULL** on that table and the obvious
`insert … select` from the sibling brick fails on it. Pre-image `bab_elsheria_backup_20260911`.
(Row counts deliberately omitted — they were stale within the hour; see
[[sos-duplicate-brick-names-are-decoys]].)

**THE MOVE IS NOT DONE UNTIL THE ALIASES FOLLOW.** Repointing customers fixes today; the NEXT import
re-resolves the town by NAME through `source_of_sales_territory_aliases`, so an unrepointed alias
quietly rebuilds the thing you just undid. Five spellings had to move with this one. See
[[sos-duplicate-brick-names-are-decoys]] for the two unique indexes that make the swap order matter.

**Since 2026-09-10 a trigger holds the write.** Any update that changes `brick_id` or `area_code` on
a row whose `source` is `owner-*`/`final-new-*`/`sheet-verified`, or that crosses a region, is
PARKED in `public.sos_map_change_holds` and the row is left untouched. The update then reports a row
count that is only the part that landed — 11 of 57 in one case — which reads like a partial failure
and is not. Release with `select public.sos_map_guard_decide(<hold id>, 'approved', '<who decided,
in his own words>')`; that function is the ONLY thing that sets the bypass, which is what separates
his approval from a script claiming it. Check `status='pending'` is 0 before calling the job done.

🔴 **`source_of_sales_customer_map.source` NAMES A LABEL THE WRITER CHOSE, NEVER A ROUTE.** On
2026-09-11 all 191 audited `admin-import` writes turned out to be a REVERT script that had simply
stamped itself with the upload's label — read as "the import overwrote 191 owner decisions" until the
actor string was read. Judge a writer by `sos_map_change_log.app_actor` and the audit `actor`, never
by `source`. Same reason the guard's own hold test refuses to consult the INCOMING source.

**The application CANNOT set `phoenix.actor`, so every guard-log row it writes reads `(direct SQL)`.**
It is a session setting and supabase-js reaches Postgres over pooled HTTP requests that cannot carry
one; setting it would mean routing the write through a `security definer` function. Do not spend an
afternoon trying. The application-side audit is what names the person: since 2026-09-11 the bulk
customer-map upload writes a per-row before/after through `writeMappingAuditBatch`, and it stamps
`source` only on a row it actually MOVES — an upload that re-states a row leaves the provenance
alone, because the export → fix → re-upload loop carries back every untouched row.

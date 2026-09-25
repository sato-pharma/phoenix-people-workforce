---
name: database-mapping-edit-delete-module
description: "/sales/database-mapping gained per-row Edit + Delete/Reactivate + brick Relocate across all 6 masters — soft-delete only, generalized from a bricks-only ask. PR #1268 MERGED to main 2026-07-23T09:08:10Z. Follow-up PR #1282 (brick_name/block description unlock) OPEN."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-07-23T19:33:57.742Z
---

Built 2026-07-23 on `codex/restore-closing-comparison-rpcs`: the owner asked for edit/delete/add on
**bricks** specifically via the `/sales/database-mapping` UI, reflected in SoS and everywhere. Add
and bulk-import already existed (config-driven across all 6 masters via `MASTER_DEFINITIONS` in
`src/lib/sales/master-data/definitions.ts`); Edit and Delete did not.

**Scope decision — generalized to all 6 masters (regions/areas/blocks/bricks/products/distributors),
not just bricks.** The existing add/import code is 100% config-driven off `MASTER_DEFINITIONS` with
no per-master special-casing; special-casing bricks-only would have been *more* code and an
inconsistent UI (one tab suddenly different from the rest). Distributors correctly get no Edit button
(zero editable columns — add-only, matches its existing "add-only master" convention) but still get
Delete/Reactivate.

**Delete = soft deactivate (`active = false`), never a hard DELETE.** This mirrors what the schema
already established, not a new pattern: every master table already has `active boolean DEFAULT true`
+ an `authenticated_read` RLS policy scoped to `active = true`, and the UI already showed an
Active/Inactive badge before this change. A hard delete would either be blocked by
`ON DELETE RESTRICT` on the region→area→block→brick hierarchy FKs, or silently orphan the plain
denormalized `brick_id`/`region_code`/etc. text columns that years of Source-of-Sales transactional
data carry (`source_of_sales_import_rows`, the `sales_ops_*` rollups, `source_of_sales_fact_rollup` —
none of these have a real FK to the masters, confirmed via schema grep). Deactivating removes a row
from every live picker/join/RLS-gated read immediately; reactivating restores it; nothing is ever
truly gone. **Why this matters for future edits here:** if the owner ever asks for a "permanent"
delete, that's a deliberate escalation from this design, not a bug to fix.

**What does NOT change retroactively (by design, matches [[sos-brick-authoritative-geography]]):**
editing a brick's `block_code` (or any master row) is re-validated + re-cascaded live (Postgres
`ON UPDATE CASCADE` propagates area/region through blocks→bricks automatically), so every live
join/RPC/dashboard reflects it immediately. Already-imported `source_of_sales_import_rows` and the
rollups built from them do **not** get rewritten — they keep the geography as it was at import time.
Bulk import (Excel) still only adds+updates, never deletes — that owner-locked rule
([[sos-brick-authoritative-geography]]-adjacent) was left untouched; only the new single-row UI
actions can deactivate.

**Other decisions:** editing a product's `factory_price` re-triggers the same best-effort
`phx_recompute_weekly_sales_value` resync bulk-import already does. Deactivating a
`SYSTEM_DISTRIBUTORS` row (Direct, tender channels, etc. — the code-defined channels re-ensured after
every distributor import) is blocked outright, since sales imports depend on them staying active.
Parent pickers (Add form AND the new Edit form) now filter to `active !== false` only, so a row can't
be silently re-parented onto something just deactivated — a small, deliberately-scoped gap-closer
now that "inactive" became a reachable state for the first time.

**Files:** `src/lib/sales/master-data/import-service.ts` (new `updateSingleMasterRow` +
`setMasterRowActive`, plus a `resolveParentValues` helper extracted out of `addSingleMasterRow`'s
previously-duplicated FK-cascade loop — `importMasterWorkbook`'s own copy was deliberately left
untouched, out of scope/risk for this change). New route
`app/api/sales/database-mapping/[master]/[key]/route.ts` (PATCH edits/reactivates, DELETE
deactivates — both fall through to the existing `/api/sales/**` catch-all in
`src/lib/security/access-registry.ts`, no new registry entry needed, same as the sibling add-row
POST). `src/components/sales/database-mapping-workspace.tsx` (inline per-row edit + confirm-before-
deactivate UI). Regression test `tests/sales-master-data-edit-delete.test.ts` (source-text style,
matching `sales-master-data-pagination.test.ts` — this whole surface is service-role DB-backed with
no live/mocked Supabase test harness in this repo).

**Verification:** `pnpm run check:harden` (lint+typecheck+test+build) all green. Live-verified the
real API routes (not just source-text) against production data via authenticated `fetch()` calls —
not-found key, the system-distributor delete guard, a no-op reactivate-already-active short-circuit,
and an invalid-`line` rejection on a real product — every case confirmed via an unchanged
`updated_at` on re-fetch that no write occurred. Did **not** do a real create/edit/deactivate
round-trip against production data (local `.env.local` targets prod, see
[[local-browser-verify-gotchas]]) and could not click through the actual rendered UI locally — that
page is blocked by a pre-existing, unrelated dev-mode-only bundling bug (see
[[local-browser-verify-gotchas]], task_e99c49bd — user started this fix in a separate session
2026-07-23). **PR #1268 MERGED** (commit fc0997c4, branch `codex/database-mapping-brick-edit-delete`,
built fresh off `origin/main` — the session's starting branch `codex/restore-closing-comparison-rpcs`
turned out stale/orphaned, upstream gone and its one commit not yet in `origin/main`, so this
delivery got its own clean branch per AGENTS.md rather than stacking onto it). Merged to main
2026-07-23T09:08:10Z. No browser click-through was ever done — offer a live round-trip test
(disposable test row) against the live app if that verification is still wanted.

**2026-07-23 follow-up — "moving a brick" reparents by spawning a new ID, not an in-place edit.**
Owner Q&A after the above shipped: does moving a brick between blocks risk breaking SoS? Answered
(no technical breakage — no FK is broken, only classification changes; historical
`source_of_sales_import_rows`/rollups correctly do NOT retroactively shift, matching
[[sos-brick-authoritative-geography]]; block/area-level reparenting cascades to ALL child
bricks/blocks automatically via real Postgres `ON UPDATE CASCADE` on the region→area→block→brick FK
chain — moving a *block* silently relocates every brick under it, not something you can do
partially). Then: brick_id (locked, immutable) doesn't change on a block-move, but this dataset's
IDs consistently encode their block as a naming convention (e.g. `B1-2` under block `B1` — verified
100% consistent across all 439 live bricks via a read-only production query, no exceptions). Owner
chose to keep that convention intact rather than leave a moved brick's ID visually mismatched, so
**"editing a brick" no longer does a plain in-place `block_code` PATCH** — it calls the new
`relocateBrick()` (`app/api/sales/database-mapping/bricks/[key]/relocate/route.ts`), which creates a
fresh `{newBlock}-{n}` brick (name/description copied, id = max existing suffix under that block +
1) and deactivates the old one — a compensating delete removes the just-created row if the
deactivate step fails, so a partial move can never leave two active bricks for one territory. This
is brick-specific, not generalized to areas/blocks (their reparenting already cascades correctly at
the DB level with no ID-convention issue to fix). `updateSingleMasterRow`'s generic in-place PATCH
still exists at the service/API layer for every master including bricks (untouched, still callable),
only the UI's Edit/Save button on the Bricks tab was rewired to call relocate instead. Tests in
`tests/sales-brick-relocate.test.ts`; same production-data-safety verification discipline as above
(negative paths only — not-found, same-block no-op, unknown/inactive target block, permission
denial — no real relocate performed against production).

**2026-07-23 second follow-up — unlocked brick_name/block description for editing, PR #1282 OPEN.**
Built in worktree `_wt-brick-master-per-line-regions` (branch
`codex/brick-master-per-line-regions`). Three gaps closed:
1. `BRICKS.brick_name` was still `locked: true` and `BLOCKS` had no `description` column at all in
   `definitions.ts` — both are now editable (block `description` also gained a real
   `derive()` -> `normalized_description`, matching every other master's normalize convention).
2. A brick edit now only routes through `relocateBrick` when `block_code` itself changed (compare
   `editValues.block_code` against the row's original value) — this applies both in `handleSaveEdit`
   and in the per-row "Move"/"Save" button label + relocate-warning hint, which previously keyed off
   `def.master === "bricks"` alone and would misleadingly show "Move" for a pure rename. A pure
   `brick_name` rename now falls through to the plain `updateSingleMasterRow` PATCH, same as every
   other master.
3. Data-loss fix: `relocateBrick` always copied the OLD `brick_name` onto the newly-spawned brick. If
   a user changed `block_code` AND `brick_name` in the same edit (now possible since brick_name
   unlocked), the rename was silently dropped. `relocateBrick` now takes an optional `newBrickName`,
   threaded through the relocate route (`brickName` in the POST body) and the UI (always sends
   `editValues.brick_name`, which `startEdit` pre-populates from the current row so it's a no-op when
   unchanged) — applied atomically with the move, audited on the new row's summary.

Full `pnpm run check:harden` (routes/migrations/stale-domains/lint/typegen/typecheck/all 425
tests/build) green. Pushed via `git push -u origin HEAD:codex/brick-master-per-line-regions` — the
branch's upstream was misconfigured to `origin/main` (not `origin/<same-name>`) when the branch/
worktree was created, so a plain `git push` would have targeted `main` directly; caught before
pushing, fixed with an explicit `HEAD:<branch>` push (also repaired the upstream tracking for next
time). PR #1282 not yet merged; no browser click-through done this round either — recommend a manual
pass on rename-only / move-only / combined-rename+move before merge.

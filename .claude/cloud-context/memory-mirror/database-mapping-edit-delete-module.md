---
name: database-mapping-edit-delete-module
description: "/sales/database-mapping has per-row Edit + Delete/Reactivate + brick Relocate across all 6 masters, config-driven off MASTER_DEFINITIONS. Delete = soft deactivate (active=false), NEVER a hard DELETE — a hard delete is blocked by ON DELETE RESTRICT or orphans the denormalized brick_id/region_code text columns that SoS transactional data carries with no FK. Moving a brick between blocks spawns a NEW id (relocateBrick), it is not an in-place block_code PATCH, because brick ids encode their block by naming convention."
metadata:
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-09-26T00:53:20.632Z
---

The `/sales/database-mapping` UI has per-row **Edit + Delete/Reactivate + brick Relocate** across all
6 masters (regions/areas/blocks/bricks/products/distributors). Add and bulk-import were pre-existing.
Everything is config-driven off `MASTER_DEFINITIONS` (`src/lib/sales/master-data/definitions.ts`) with
no per-master special-casing — generalizing to all 6 was *less* code than a bricks-only special case.

## 🔴 Delete = soft deactivate (`active = false`), NEVER a hard DELETE

This mirrors the existing schema, not a new pattern: every master table already has
`active boolean DEFAULT true` + an `authenticated_read` RLS policy scoped to `active = true`. A hard
delete would either be **blocked by `ON DELETE RESTRICT`** on the region→area→block→brick hierarchy FKs,
or **silently orphan the denormalized `brick_id`/`region_code`/etc. text columns** that years of
Source-of-Sales transactional data carry — `source_of_sales_import_rows`, the `sales_ops_*` rollups,
`source_of_sales_fact_rollup`, **none of which have a real FK to the masters.** Deactivating removes a row
from every live picker/join/RLS-gated read immediately; reactivating restores it; nothing is ever truly
gone. **If the owner ever asks for a "permanent" delete, that is a deliberate escalation from this design,
not a bug to fix.**

## Editing is live-cascaded but does NOT rewrite history

(Matches [[sos-brick-authoritative-geography]].) Editing a master row is re-validated and re-cascaded
live — Postgres `ON UPDATE CASCADE` propagates area/region through blocks→bricks automatically — so every
live join/RPC/dashboard reflects it immediately. But **already-imported `source_of_sales_import_rows` and
the rollups built from them are NOT rewritten** — they keep the geography as it was at import time. Bulk
Excel import still only adds+updates, never deletes (owner-locked, untouched); only the single-row UI
actions can deactivate.

- Editing a product's `factory_price` re-triggers the same best-effort `phx_recompute_weekly_sales_value`
  resync that bulk import does.
- **`SYSTEM_DISTRIBUTORS` rows (Direct, tender channels — the code-defined channels re-ensured after every
  distributor import) cannot be deactivated** — sales imports depend on them. Distributors get no Edit
  button (add-only master, zero editable columns) but do get Delete/Reactivate.
- **Parent pickers (Add form AND Edit form) filter to `active !== false`** so a row can't be silently
  re-parented onto something just deactivated.

## 🔴 Moving a brick spawns a new id — it is not an in-place `block_code` edit

Brick ids encode their block by naming convention (`B1-2` under block `B1`, 100% consistent across live
bricks; owner chose to keep it intact rather than leave a moved brick's id mismatched). So on the **Bricks
tab only**, changing `block_code` calls `relocateBrick()`
(`app/api/sales/database-mapping/bricks/[key]/relocate/route.ts`): it creates a fresh `{newBlock}-{n}`
brick (id = max existing suffix under that block + 1) and deactivates the old one, with a **compensating
delete** if the deactivate fails so a partial move can never leave two active bricks for one territory.

- **Brick-specific only** — area/block reparenting already cascades correctly at the DB level (moving a
  *block* silently relocates every brick under it, all-or-nothing). The generic in-place
  `updateSingleMasterRow` PATCH still exists at the service/API layer for every master including bricks
  (untouched, still callable); only the Bricks-tab Edit button was rewired to relocate.
- **Relocate fires only when `block_code` actually changed** — a pure `brick_name` rename falls through to
  the plain `updateSingleMasterRow` PATCH like every other master (the "Move" vs "Save" button label keys
  off the block_code comparison, not off `master === "bricks"`).
- **A combined rename+move must thread the new name through relocate** (`newBrickName` → `brickName` in the
  POST body), applied atomically with the move — otherwise `relocateBrick` copies the OLD name onto the
  spawned brick and the rename is silently dropped.

## Files & wiring

`src/lib/sales/master-data/import-service.ts` (`updateSingleMasterRow`, `setMasterRowActive`,
`resolveParentValues` helper — `importMasterWorkbook`'s own FK-cascade copy was left untouched, out of
scope); route `app/api/sales/database-mapping/[master]/[key]/route.ts` (PATCH edits/reactivates, DELETE
deactivates); `src/components/sales/database-mapping-workspace.tsx`. Both routes fall through to the
existing `/api/sales/**` catch-all in `src/lib/security/access-registry.ts` — **no new registry entry
needed.** Tests: `tests/sales-master-data-edit-delete.test.ts` and `tests/sales-brick-relocate.test.ts`,
both **source-text style** — this whole surface is service-role DB-backed with no live/mocked Supabase test
harness in this repo (see [[local-browser-verify-gotchas]] for why UI click-through can't be driven
locally).

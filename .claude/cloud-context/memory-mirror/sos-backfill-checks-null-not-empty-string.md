---
name: sos-backfill-checks-null-not-empty-string
description: "FIXED and MERGED (PR #1984 + #1985): sos_backfill_import_rows_from_customer_map filtered on brick_id IS NULL, but unresolved rows are stored as brick_id = '' — so it had always silently updated zero rows"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b71e694-029e-4781-b482-d78f60d8a606
  modified: 2026-08-09T22:49:45.357Z
---

**STATUS 2026-08-10: FIXED on staging AND production, PR #1984 MERGED** (2026-08-09T22:28:35Z,
commit `b7a3dcd0`) — this memory's earlier "still needs merging" note is stale, do not repeat it.
The migration file is now `supabase/migrations/20260809222929_sos_backfill_matches_empty_brick_
sentinel.sql` (renamed from `20260810120000_...` by follow-up
[PR #1985](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1985) so its filename
matches the version production's ledger actually recorded — see
[[mcp-apply-migration-versions-drift-from-filename]] for why that mismatch happens and why it
wasn't a CI failure either way). The predicate is broadened to `(r.brick_id is null or r.brick_id
= '')`. Applied + functionally verified on **staging** (a real row healed end-to-end: `brick_id`/
`area_code`/`region_code` all corrected, rollups refreshed). Applied to **production**
(owner-approved in-conversation) and verified live via `pg_get_functiondef` +
`information_schema.routine_privileges` (EXECUTE is `service_role` + `postgres` only, no
`public`/`anon`/`authenticated`). Regression test `tests/sos-backfill-empty-brick-
sentinel.test.ts` pins the fix; proven via the required break→fail→restore→pass cycle. Confirmed
no sibling RPC shares the bug — `sos_reconcile_import_rows_from_customer_map`,
`sos_count_reconcilable_import_rows`, `phx_sync_sos_restamp_import_rows`, `phx_sync_sos_run` all
use null-safe, empty-string-safe `IS DISTINCT FROM`.

Live scope at fix time: 658 stale `''` rows on production (DIRECT 653 — structurally unmappable,
Direct-channel sales carry no customer code at all — RM 2, SF 2, EG 1), 533 on staging. Only 5
rows / 4 real customers (RM/SF/EG) are genuine gaps still needing a customer→brick mapping before
even the fixed backfill has anything to act on — the fix alone does not retroactively heal them.
Also found in passing, flagged separately (not fixed here): 34 production rows sit under
distributor_code `'Direct'` (mixed case) vs `'DIRECT'` — see spawned task on distributor-code
casing.

Original finding, confirmed live 2026-08-09 while fixing 135 Pharma Overseas (PS) customers' brick
mapping on the July 2026 batch (`a4263715-708b-4d64-bf3c-74cccc9eb3fd`):
`source_of_sales_import_rows.brick_id` for an unresolved row is an **empty string `''`, never
`NULL`** — consistent with `CodedRow.brickId` being typed `string` (non-nullable) in
`src/lib/sales/normalizer/types.ts`.

`sos_backfill_import_rows_from_customer_map` (the RPC behind `backfillCustomerRows` in
`src/lib/sales/normalizer/mapping.ts`, wired to the `backfill` flag on both `addCustomerMapRow` and
`importCustomerMap` in `src/lib/sales/normalizer/customer-map.ts` — i.e. the "heal historical rows"
option in the Mapping Database UI) filters on `r.brick_id is null`. That predicate never matches
`''`, so the checkbox has almost certainly been silently backfilling **zero** rows every time anyone
has ever used it, with no error — it just reports `backfilled: 0`, which reads as "nothing needed
fixing" rather than "the check can never fire."

**Why this matters:** the crosswalk (`source_of_sales_customer_map`) fix and the historical-rows fix
are two separate steps (see [[moving-a-sos-brick-between-areas-needs-four-restamps]] and
[[repointing-a-block-area-leaves-crosswalk-and-directory-stale]] for the same "fixing the map isn't
enough" pattern elsewhere in SoS). Anyone who trusted the backfill checkbox to have healed already-
imported rows almost certainly has stale `brick_id=''` rows sitting in production right now, in
whatever batches that checkbox was ever used on.

**How to apply:** the RPC fix landed in PR #1984, is merged, and is live on production — background
task `task_1ed37f59` is superseded by that PR. `backfilled: N` from `addCustomerMapRow`/
`importCustomerMap` is now trustworthy again (for rows whose customer already has an active
mapping — it still won't touch rows whose customer has no mapping at all, e.g. DIRECT). The 658
production / 533 staging stale rows found at fix time are NOT retroactively healed by the fix
itself — they stay `brick_id=''` until someone re-saves/re-imports the matching customer mapping,
or an explicit owner-approved bulk pass runs.
The one-off manual per-batch fix pattern (mirror the RPC's UPDATE but with `(r.brick_id is null or
r.brick_id = '')`, then refresh `phx_refresh_sos_fact_rollup` / `phx_refresh_sos_customer_directory_
rollup` / `phx_refresh_marketing_roi_facts` for the affected batch IDs) is still safe to repeat
scoped to a specific batch_id if needed before the RPC fix reaches production, but don't run it
unscoped across all distributors without owner approval — see the "still needs a customer_map
entry" scope note above for why an unscoped run would mostly do nothing anyway right now.

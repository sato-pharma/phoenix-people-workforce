---
name: a-brick-move-leaves-its-rollup-files-pending-with-nothing-draining-them
description: "sos_relocate_brick queues its sales files for a rollup rebuild and ONLY an open Database Mapping page drains them — two moves sat undrained for a day, so every Qena figure on screen was pre-move"
metadata:
  node_type: memory
  type: project
  originSessionId: 0be92338-9743-4b23-ba29-cd28bd8597f5
  modified: 2026-10-12T22:57:05.535Z
---

🔴 **A BRICK MOVE DOES NOT REBUILD `source_of_sales_fact_rollup` — IT QUEUES THE FILES IN
`source_of_sales_brick_move_files`, AND THE ONLY THING THAT DRAINS THAT QUEUE IS A HUMAN WITH THE
DATABASE MAPPING PAGE OPEN.** There is no cron, no job, no trigger.

**Why:** measured on production 13 Oct 2026. The قوص and أبنود moves of 12 Oct had left **18 + 53
files** with `refreshed_at is null` since 12 Oct 13:27 Cairo — so for a full day every Qena number on
every screen was still **pre-move**, while the brick master, the customer map and the import rows had
all already moved. Nothing anywhere said so: `sos_relocate_brick` returns `pendingFiles` in its
result and then the page's poller (`src/components/sales/brick-move-refresh.tsx`) is the only caller
of `POST /api/sales/brick-moves/refresh`. Close the tab and the rebuild simply stops.

**How to apply:** after ANY `sos_relocate_brick`, drain the queue yourself and do not call the move
done until `select count(*) from public.source_of_sales_brick_move_files where refreshed_at is null`
is **0** — checking the brick row is not evidence. Per file, in order:
`phx_refresh_sos_fact_rollup` + `phx_refresh_sos_customer_directory_rollup` +
`phx_refresh_marketing_roi_facts` (any order), then `phx_refresh_sos_channel_rollup`, then
`phx_refresh_sos_distributor_product_rollup`, then `phx_refresh_sos_import_summaries`, then
`sos_finish_brick_move_file(old_brick, batch_id, moved_at, true)`. The store-split net step the app
does per batch is TypeScript, so cover it afterwards at period grain with
`scripts/backfill-attribution-store-split.ts --apply <periods>` and
`au.f_refresh_monthly_attribution('<period>')`.

🔴 **Two channel traps when draining.** (1) **`phx_refresh_sos_fact_rollup` on a big batch exceeds
the PostgREST statement timeout** (`57014`, "canceling statement due to statement timeout") — so a
script going through `/rest/v1/rpc/...` must SKIP and continue rather than retry, because a failed
file is never marked done and re-reading the pending list hands the same row back for ever. Finish
those stragglers over the Supabase MCP connection, which tolerates far longer statements.
(2) **A `DO` block through the MCP is ONE transaction, and a client timeout rolls the whole block
back** — a 240-second budget committed nothing at all while a 45-second one committed 22 files. Keep
any such loop comfortably under ~50 seconds, or do the work one file per request.

Also still true from `moving-a-sos-brick-between-areas-needs-four-restamps`:
`source_of_sales_blocks.master_brick_id` has **no FK** and `sos_relocate_brick` never re-points it,
so a block whose master brick just left keeps naming a brick in another area — re-point it by hand.
See [[qena-city-is-qena-2-on-every-line]] for the move this was measured on.

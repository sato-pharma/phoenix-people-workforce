---
name: moving-a-sos-brick-between-areas-needs-four-restamps
description: "A SoS brick's area is not directly editable (composite FK via block) and relocateBrick re-stamps only 1 of the 4 downstream tables — the other 3 silently keep the old area"
metadata: 
  node_type: memory
  type: project
  originSessionId: 82472132-9643-4a3e-90cd-01df96036e07
  modified: 2026-08-05T22:20:54.599Z
---

`source_of_sales_bricks.area_code` **cannot be edited directly**: a composite FK
`(block_code, area_code, region_code) -> source_of_sales_blocks` forces area+region to follow the
BLOCK. Moving a brick between areas means moving it to a block that already lives in the target
area, and `relocateBrick` (`src/lib/sales/master-data/import-service.ts`) then **spawns a new
`{block}-{n}` brick ID and soft-retires the old one** (owner preference, 2026-07-23 — the ID prefix
must match the block).

**The trap:** `relocateBrick` cascades **only** `source_of_sales_customer_map`. It leaves
`source_of_sales_import_rows`, `source_of_sales_fact_rollup`, and
`source_of_sales_customer_directory_rollup` pointing at the retired brick ID with its OLD
`area_code` — which silently violates [[sos-always-todays-geography-rule]]. Nothing errors; past
months just keep reporting under the old area. `import_rows` is the master (both rollups are
rebuilt from it by `phx_refresh_sos_fact_rollup` / `phx_refresh_sos_customer_directory_rollup`,
per batch), but those RPCs are batch-scoped, so a geography move needs a direct re-stamp of all
four tables — not a refresh call.

Also check, because none of it has an FK and an FK inventory reports "nothing references this"
(same shape as [[deleting-an-employee-needs-a-full-text-scan]]):
`source_of_sales_blocks.master_brick_id` and the `source_of_sales_block_groups` VIEW's
`master_brick_id` — a block whose representative brick is the one leaving must be re-pointed
BEFORE deactivation, or the block's UI label names a brick in a different area.

**Why:** first-ever production brick relocation was 2026-08-06 (Kafr El-Sheikh realignment — فوه to
KES 1; بيلا + الحامول to KES 2). Nothing had exercised this path before, so the partial cascade had
never fired.

**How to apply:** re-stamp `brick_id` + `area_code` + `region_code` across all four tables in ONE
transaction, plus `block_code`/`area_name` on `import_rows` (it carries both). Verify by proving the
two areas' `total_qty` sums to exactly the pre-change total (conservation), and that
`fact_rollup JOIN bricks WHERE area_code IS DISTINCT FROM` returns 0. Pre-image backup schema
pattern: `kes_realign_backup_20260806`, grants revoked from anon/authenticated.

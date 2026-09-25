---
name: closing-detail-areacode-is-brick-not-fact-area
description: "ClosingDetailRow.areaCode is the BRICK's master area, but every closing RPC books by the FACT area — asking areaCode 'where is this customer' silently misses every hand-split"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9294015a-8dfc-4702-8fc7-a7376e635d0e
  modified: 2026-08-06T21:38:15.306Z
---

`loadMonthlyClosingDetails` sets `areaCode = brick.areaCode || sheetAreaCode`
([monthly-closing-details.ts](src/lib/sales/monthly-closing-details.ts) ~line 540) — the BRICK's
master area wins. But **every** closing RPC books by the FACT area (`fact_rollup.area_code`, which is
`import_rows.area_code` verbatim): verified live 2026-08-06 via `pg_proc` for
`phx_monthly_closing_matrix`, `phx_closing_customers`, `phx_closing_distributor_product`,
`phx_closing_channel_breakdown`. The row keeps the original as `sheetAreaCode`.

**They diverge ONLY on a hand-split customer** — the split is written to the fact rows and the brick
is deliberately left alone (see [[july-anti-infective-reunion-split-exception]]). Measured live
across all 153,053 (period, line, client) groups: **exactly 4 rows diverge**, all client 441164,
2026-07, −34,380.

**Why:** the same wrong assumption bit twice in one module. PR #1861's
`customersAlreadySplitAcrossAreas` read `areaCode`, saw one area (D21) for a customer split D22/D26,
never exempted it, and the export re-split the return across Dakahlia — *the fix shipped, the
migration applied, and the workbook did not change*. Then `narrowClosingDetailsToAreas` matched on
`areaCode` too, putting those rows on the Data sheet of a workbook whose Matrix lacked them.

**How to apply:** before writing anything that asks "which area is this row in", decide which
question you mean. A customer's own master location (permission scoping in
`applyLineRegionScope`'s `allowedAreaCodes`, display) → `areaCode`. *Where did a human put this* or
*does this reconcile against a closing RPC* → the new shared helper `closingAreaOf` in
[src/lib/sales/closing-row-area.ts](src/lib/sales/closing-row-area.ts) (`sheetAreaCode` first,
`areaCode` fallback) — also exposes `isRebookedRow` (fact ≠ resolved) and `resolvedAreaOf`.

2026-08-06 fixed the export's own narrowing + split. 2026-08-07 closed 4 more instances found by
writing real regression tests against this exact fix — each one made a "correct" fix ship with no
visible effect, twice in a row, which is why every one of these now has a prove-it-fails test:
1. **`applyDetailFilters`** (the on-screen Details tab) matched resolved `areaCode` — a filtered
   drill-down disagreed with its own Matrix. Now uses `closingAreaOf`.
2. **`comparisonLeavesFromRows`'s customer leaf** folded ALL of a customer's rows into ONE leaf
   keyed by `distributor+client` only (no area) — a SEPARATE, pre-existing bug (present even before
   the areaCode-vs-sheetAreaCode confusion): `phx_closing_customers` already returns one row PER
   AREA in SQL, so the from-rows path's grain never matched the RPC path's. Fixed by adding
   `closingAreaOf`-derived area to the key, matching the RPC exactly.
3. **`customersAlreadySplitAcrossAreas`** exempted on "spans >1 area" alone — a genuine two-depot
   wholesaler (fact==resolved in each of its own areas) would silently stop splitting. Now requires
   BOTH a multi-area spread AND `isRebookedRow` on at least one row (fact≠resolved is the actual
   fingerprint of a hand re-allocation).
4. **The Channel Breakdown brick grid** (`store-split-channel-breakdown.ts`) pools every customer
   sharing a `(brick, area)` pair into one grid figure and debits the whole thing whenever that area
   gave money up — so an exempt customer sharing a brick with a genuinely eligible seller got
   debited for money the Matrix never moved. Fixed by reporting exempt store value **per
   `(brick, area)` pair, not per brick** (`exemptStoreValueByBrick`, key `${brickId}|${areaCode}`) —
   per-brick-only was tried FIRST and is subtly wrong: it over-subtracts when the exempt customer has
   eligible legs in more than one area of the same brick, silently under-debiting an unrelated
   eligible neighbour. Caught only because the test used POSITIVE money — 441164's own return is
   negative, and `applyStoreSplitToChannelBreakdown`'s `take <= 0` guard (written for "a take is
   always a positive amount actually sold") already no-ops on any negative debit regardless of this
   fix, so a negative-money fixture cannot exercise this code path at all. If a FUTURE hand-split
   customer needs the brick grid to protect a positive value, test it with positive money or the
   assertion vacuously passes.

`applyDetailScope` (authz) and `applyLineRegionScope`'s `allowedAreaCodes` (permission boundary,
`access-scope.ts`) deliberately still match resolved `areaCode` — untouched, correctly.
`phx_closing_corrections` (`closing-corrections.ts`) reads `f.area_code`/`r.area_code` straight off
the fact/sheet tables in SQL, never through brick resolution — structurally immune to this bug
class, checked 2026-08-07, no fix needed.

---
name: closing-channel-breakdown-two-figures-two-sources
description: "The Channel Breakdown's movedValue and movedFromBricks come from two different sources that genuinely disagree — a gap between them is usually NOT the negative-store bug"
metadata: 
  node_type: memory
  type: project
  originSessionId: b5cb3ab8-c71a-4472-a7ca-197b1198f3b5
  modified: 2026-08-06T15:44:30.775Z
---

The Monthly Closing Channel Breakdown states one store-split movement **twice**, from **two
different data sources**, and they disagree in production:

- `storeSplit.movedValue` (the note above the grids) is folded from the **closing detail invoice
  rows** — same source as the Closing Matrix, via `splitStoreSalesAcrossCityAreas`.
- `storeSplit.movedFromBricks` (the Brick grid's "shared across the city" row) is read off the
  **`phx_closing_channel_breakdown` RPC's `brick_area` rows**, which classify a customer from
  `source_of_sales_customer_directory_rollup`.

`src/lib/sales/store-split-channel-breakdown.ts` chose that split deliberately (its header says so),
so **`movedFromBricks === movedValue` is NOT structurally guaranteed** — it holds only when the two
sources agree about a customer's channel AND its area.

**Why this bites:** measured 2026-08-06 across 3 lines x 7 periods, 12 of 21 line-months violated it,
from **two unrelated causes**:

1. **Negatives were dropped** (fixed 2026-08-06, PR on `codex/channel-negative-store-split`): the
   applier's `Math.min(out, brick.store)` + `take <= 0` refused to move returns. Clean cases:
   Anti Infective 2026-04 (16,672.50) and Pedia 2026-05 (21,600.00).
2. **Source disagreement** (still open): the RPC and the details put the same customer's money in a
   different AREA or a different CHANNEL. Anti Infective 2026-07 is the loudest — the owner's
   July/Anti-Infective exception puts ريونيون للتجارةوالاستثمار's −34,380 on D22+D26 in
   `customer_map` while the invoice rows keep it on D21 (see
   [[july-anti-infective-reunion-split-exception]]), so `outByArea` never learns D22/D26 gave
   anything up and the brick side skips both. CNS carries a milder version in all seven months.

**How to apply:** before attributing a `movedFromBricks` vs `movedValue` gap to negatives, split it
into `Σ outByBrick − movedValue` (source gap) and `movedFromBricks − Σ outByBrick` (applier loss).
The second is the only part this module can close. Closing the first needs the brick side fed from
the same rows the movements are, which changes the module's input contract and is an owner decision.
Related: [[closing-uses-total-qty-not-effective-units]], [[sos-client-address-is-inferred-not-from-distributors]].

---
name: a-lines-unmapped-share-is-usually-its-direct-order-book
description: "25.8% of Anti Infective's September value had no active `source_of_sales_customer_map` row and it was the direct-order book exactly — all 58 `DirectReq` rows, every one carrying an area AND a brick — so join on `is_direct` before reading an unmapped share as a mapping hole."
metadata:
  node_type: memory
  type: reference
  originSessionId: 9828b8ae-f17d-4189-8df8-a7baee24cd4f
  modified: 2026-10-10T12:36:43.674Z
---

Measured on production 2026-10-10. Share of September value with a `client_code` but no active
customer-map row: CNS **0.0%**, Anti Infective **25.8%** (210,519.30 of 815,692.45 EGP). Breaking it
down by `distributor_code` returned exactly one group — `DirectReq`, `is_direct = true`, 58 rows,
`210,519.30`, with **0 rows missing an area and 0 missing a brick**.

A direct order has no distributor, so it never needs a distributor customer-map row: the request
itself carries the geography. The same arithmetic explains August's 7.8% (≈ that month's `DirectReq`
total) and July's 0.0% (no direct rows on the line at all).

The companion measure, confidence below 70, is the map's standing state and not a September problem:
CNS 69.8% of value in July, 73.3% in August (**both published**), 67.1% in September — September is
the best of the three. Anti Infective runs 74.1 / 75.8 / 85.7%.

**Why:** an unmapped or low-confidence share looks alarming as a single percentage and says nothing
on its own; a published month is the only honest baseline.

**How to apply:** before calling an unmapped share a hole, group it by `distributor_code` and
`is_direct` and check `area_code`/`brick_id` are populated. Before calling a confidence share a
problem, read the same figure for July and August — they are published, so anything no worse than
them is already accepted. See [[sos-monthly-closing-is-the-only-sales-truth]].

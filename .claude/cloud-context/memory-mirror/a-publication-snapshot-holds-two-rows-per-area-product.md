---
name: a-publication-snapshot-holds-two-rows-per-area-product
description: "monthly_closing_publications.snapshot_breakdown carries one row per area × product × DIRECT flag, so a diff joined on (area, product) alone multiplies the rows and reported 85 moved cells / 486,491.22 EGP where the truth was 57 / 94,196.16 — aggregate both sides before comparing."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T17:05:00.000Z
---

`public.monthly_closing_publications.snapshot_breakdown` is a JSON array of `{a: area, p: product,
u: units, v: value, d: is_direct}` — and **`d` is part of the key**. The same area × product appears
TWICE when a line has both direct and distributor sales there.

**Why:** a full join of the snapshot against `au.monthly_attribution_rollup` on `(area, product)`
alone therefore pairs each rollup row with two snapshot rows, and every doubled key reads as a
difference. Measured on 2026-09 Anti Infective, 9 Oct 2026: the naive join reported **85 of 108
cells moved and 486,491.22 EGP of absolute difference**, while the same comparison with both sides
aggregated to `(area, product)` reported **57 of 89 keys and 94,196.16 EGP changing hands**. The
give-away was one area × product appearing twice in the top-movers list with the same `units_now`
and two different snapshot figures — and that `snapshot_cells` (108) happens to count the
UNaggregated rows, so matching it is no proof the join is right.

**How to apply:** `group by area_code, product_code` on BOTH sides before the join (or carry `d`
into the join key on both), and sanity-check that the net unit change is exactly 0.000 — the split
is unit-preserving, so a redistribution MUST net to zero. A non-zero net means the comparison, not
the data, is wrong. Related: [[publishing-one-line-freezes-the-whole-periods-store-split-net]],
[[sos-monthly-closing-is-the-only-sales-truth]],
[[a-mismatch-query-hides-the-row-that-matches]].

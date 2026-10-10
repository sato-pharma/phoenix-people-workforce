---
name: only-one-gamaliya-brick-exists-and-it-is-dakahlias
description: "A Cairo pharmacy can be filed in the Delta because the brick table holds only ONE الجماليه — Dakahlia's — and Cairo's الجمالية district has no brick at all, so the resolver has nowhere else to land it; check whether a brick NAME is unique before reading its area as evidence."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
---

`source_of_sales_bricks` holds exactly one brick named `الجماليه`, and it sits in **Dakahlia 3 ·
Delta (2)**. الجمالية is also a well-known Cairo district (beside الدراسة, in Islamic Cairo) — and it
has **no brick of its own**. So every Cairo الجمالية customer the resolver meets is filed into the
Dakahlia brick, hundreds of kilometres and one region away, with nothing in the data looking wrong.

Found 2026-10-10 on `لطفى / الدراسة` (EGD / 40709), whose own NAME carries الدراسة and whose filed
address is `6 شارع الشيخ صالح الجعفرى - بلوكات السوارى` — a Cairo street. It had been sitting in
الجماليه · Dakahlia 3 since February 2026, 6 rows / 1,235.25 EGP of CNS, until his Mapping Guard
approval moved the map to الدراسة · Down town · Cairo and the reconcile re-pointed the rows.

- **Before reading "the rows sit in area X" as evidence of anything, ask whether that brick's NAME is
  unique.** A duplicated Egyptian place name with only one brick is a one-way funnel, not a signal.
- The matching query is cheap: `select brick_id, brick_name, area_code from source_of_sales_bricks
  where brick_name = '<name>'` — more than one row means the resolver had a choice, one row means it
  did not.
- The same shape is why [[a-villages-town-is-read-from-its-neighbours-bricks]] works: the neighbours'
  bricks carry the evidence the name cannot.

Related: [[the-normalizers-place-match-can-name-a-brand-not-a-place]] — the other way a name match
lands in the wrong governorate.

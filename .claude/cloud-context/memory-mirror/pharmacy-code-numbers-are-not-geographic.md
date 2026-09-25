---
name: pharmacy-code-numbers-are-not-geographic
description: "Never identify a pharmacy by picking the numerically nearest distributor code — POS codes are not allocated by area, and a gap-of-1 neighbour was 110km away in a different governorate"
metadata: 
  node_type: memory
  type: project
  originSessionId: e57e90b1-6df8-4f5f-b57e-e8bd26ebf3a5
  modified: 2026-08-19T23:20:00.000Z
---

**A distributor code that is numerically adjacent tells you NOTHING about where the shop is.**
Codes are issued over time, not by territory.

**Proved 2026-08-19, and it nearly caused a bad production write.** Pharmacy الشفاء sits at
`30.9683, 30.9600` — Madinet Qotour, **Gharbia**, GPS captured on site. Its entered code `1558287`
was absent everywhere, and the numerically nearest POS code was `1558286` — **a gap of one**, with
four codes sharing its first six digits, sitting inside a dense allocated block. It looked like an
obvious single-digit slip.

`0001558286` is **وليد احمد عاطف - فيصل**, at ش الملك فيصل، الكوم الأخضر — **الهرم ٢ / فيصل، Giza,
110.7 km away**. The real answer was not POS at all: **Ibn sina `361157` "الشفاء جديدة"**, قطور قطور,
brick `B193-5`.

**The falsifier, so this is not just one anecdote:** POS's 14 `الدقهلية`-tagged pharmacies in قطور
run from `1507300` to `1578606` — scattered across the entire range. Numeric proximity within a
distributor is noise. Re-verified on prod 2026-08-19, and it holds at **both** grains: those 14 rows
in `marketing_pharmacy_code_references` and the 39 قطور rows in `source_of_sales_customer_map` share
those exact endpoints.

**Two traps this exposes**

1. **A wrong code may mean the wrong DISTRIBUTOR, not the wrong digits.** Searching harder inside
   POS could never have found الشفاء. Always widen to every distributor before concluding a code is
   missing — see [[marketing-not-found-codes-have-three-root-causes]] root cause 1.
2. **`raw_region` on `marketing_pharmacy_code_references` is unreliable — and *inconsistently* so.**
   14 POS قطور rows carry `raw_region = الدقهلية`, yet Qotour is in **الغربية** — one of them even
   says "محافظه الغربيه" in its own address field. **Refinement, measured 2026-08-19: POS has 19
   قطور rows in total, not 14** — the other five carry `الغربية` (4) and `قنا` (1). So the column is
   not uniformly wrong, it is inconsistent, which is worse than uniformly wrong: there is no constant
   correction to apply, and a region filter keeps a lucky subset while silently dropping the rest —
   including, here, the four rows that were actually right. Never filter candidates on that column;
   `raw_pharmacy_address` / `raw_area` are usable, and the region is the distributor's own bad data.

**What to do instead** — `public.source_of_sales_customer_map` carries **`customer_name`** and
`address` and is the name authority (`marketing_pharmacy_code_references` has no name column at
all). Search it by name, then require the GPS to agree. Order of strength is GPS > name > code, per
[[marketing-not-found-codes-have-three-root-causes]] — the numeric neighbour is not on the list at
all, and I offered one as a recommendation before checking the name. Do not repeat that.

Related: [[duplicate-pharmacy-test-is-name-and-gps-not-brick]],
[[marketing-reference-list-is-a-point-in-time-import]],
[[guard-every-prod-write-when-another-session-shares-the-queue]].

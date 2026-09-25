---
name: marketing-reference-raw-area-drifts-raw-region-does-not
description: "In marketing_pharmacy_code_references, raw_region is trustworthy for geography but raw_area and raw_pharmacy_address are not — and 5 of 25 captured code rows leave raw_region blank."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-19T22:45:29.967Z
---

`marketing_pharmacy_code_references` carries FOUR location columns and only ONE is safe to compare
a GPS capture against.

- **`raw_region` — the governorate. TRUSTWORTHY.** Verified against all 25 captured production code
  rows on 2026-08-20: 19 agree with the rep's reverse-geocoded capture, 1 disagrees, 5 are blank.
- **`raw_area` — DRIFTS, even when the region is right.** Reference row `8553` (code `0001552116`)
  is filed under area `المحلة الكبري` while its own address reads `الشين- قطور`, ~40 km away. Its
  region, `الغربية`, is correct for both. Comparing at area level would hold honest links.
- **`raw_pharmacy_address` — free text that NAMES OTHER GOVERNORATES.** Row `9302` (code `330340`)
  reads `16ناصيه هارون والمنصوره` under region `القاهرة`. Parsing it resolves Dakahlia (المنصورة)
  and invents a mismatch.

**Why:** on 2026-08-20 a governorate check was built to compare the captured GPS address against the
code's registered location, and the owner made it BLOCK. Picking the wrong column would turn a
labelling quirk in Phoenix's own import into a `pending` link that only a Super Admin / CEO can
release. An earlier draft of that code cited the `raw_area` drift as if it were `raw_region` drift —
caught by querying production, not by reading the row back from memory.

**How to apply:** for any geography comparison against this table, read `raw_region` and nothing
else. Treat a blank region as *not comparable*, never as a contradiction — the blanks are Phoenix's
own data gap and must not count as evidence against a rep. See
[[marketing-reference-list-is-a-point-in-time-import]] for why this table is stale by nature, and
[[marketing-customers-belong-to-areas-not-people]] for the area model it must not be confused with.

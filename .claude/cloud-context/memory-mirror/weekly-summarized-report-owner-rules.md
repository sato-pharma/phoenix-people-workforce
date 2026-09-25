---
name: weekly-summarized-report-owner-rules
description: "Weekly Sales \"Summarized Report\" - the owner's locked layout and scope rules, learned over many rejected iterations"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 79f3f577-f3d1-4ba8-9694-cc8af3320030
  modified: 2026-08-11T18:58:08.532Z
---

The **Summarized Report** is the SECOND export on Sales → Weekly Sales → Dashboard, beside "Export
Excel". The original BI export must stay byte-identical — nothing may import `export-workbook.ts`
or `export-kit.ts`.

Rules the owner corrected me on, each after a rejected build:

- **Every number must be traceable to a PRODUCT.** A blended "branch = 500 units" is worthless
  without knowing 500 of what. This is the central requirement.
- **One block per LINE, stacked under each other** — never all lines' products side by side in one
  grid. Each line gets its own region × product matrix.
- **Tab 1 = Region × Product matrix.** Rows = region, columns = one `Sales Units | Stock Units` pair
  per product. Regions need no new mapping: fact rows already carry `regionCode`, resolved at import
  from the weekly branch→region map.
- **Units and Stock only — no Value column.**
- **Units are DE-CUMULATED** (the week's own sale). Sheets are cumulative within a month: overseas
  Royafloxacin June W3 = **428**, not the 945 printed on the sheet (945 already contains W1+W2).
- **Region order = Monthly Closing order**, from the now-exported `MONTHLY_CLOSING_REGION_ORDER`
  in `monthly-distributor-import.ts`: CA, GZ, UE, UE-1, UE-2, AB, D1, D2, OT.
- **PDA means Pedia.**
- Unmapped products are excluded — see [[unmapped-products-must-never-reach-a-report]].
- **Work tab by tab.** He asked explicitly: finish one tab, send a generated preview, wait, then the
  next. Do not build all five and present them together.

**Why it kept going wrong:** I repeatedly inferred layout instead of showing him a mock. What worked
was giving him 2-3 concrete previews with real numbers and letting him pick — do that first.

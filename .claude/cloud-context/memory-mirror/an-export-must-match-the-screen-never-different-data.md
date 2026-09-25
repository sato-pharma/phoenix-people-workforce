---
name: an-export-must-match-the-screen-never-different-data
description: "Owner rule 2026-08-26 - an exported workbook must show exactly what the screen shows; a sheet or column may never be dropped silently because it cannot be filtered"
metadata:
  type: feedback
---

**OWNER RULE, 2026-08-26, stated twice and emphatically:** *"The exported file must be typical the
front end... the export sheet must be perfectly matching this. Sync it together. Never different
data."*

An export is not allowed to quietly contain a different set of numbers from the screen it was
launched from. If a figure is on screen, it belongs in the file.

**Why:** the Monthly Closing export nulled the Office grid whenever a row-level filter was active
(distributor, included/excluded, or the details search box), so the workbook lost both the
`of wh. Office` columns and the Office Allocation sheet while the on-screen Closing Matrix kept
showing them. Office is ~41% of the CNS closing — the largest figure in the report vanishing with no
note. The code had a *reasoned* justification in a comment, and the reasoning was even sound; the
owner still rejected it. **A defensible reason to hide something is not permission to hide it.**

**How to apply:** When a dimension genuinely cannot be narrowed — the Office grid is built from an
aggregate carrying no customer and no distributor, so a row-level filter has nothing to match —
**carry it anyway and label it in the workbook's filter note** ("the WHOLE month's Office component
and NOT narrowed by this filter"). Never drop it. Every other omission in that workbook was already
announced in the filter note; Office being the one silent one is what made it a bug.
Fixed in #2430 (`app/api/sales/monthly-closing/export/route.ts`), pinned by
`tests/export-follows-screen-filters.test.ts` — the file that exists to stop a report and its export
drifting apart. Note the two export triggers send different payloads: the Closing Matrix screen
sends only area/product/region/search, while `closing-details-panel.tsx` also sends
`distributorCodes`/`inclusion`/`detailSearch` — only the second can set `rowLevelActive`.
See [[closing-reads-distributor-product-rollup-not-fact-rollup]] and
[[unmapped-products-must-never-reach-a-report]].
